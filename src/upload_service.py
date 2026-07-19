import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import logging
from dataclasses import dataclass, field
from typing import Callable, List, Optional
from urllib.parse import urlparse

import psutil

from destinations import DestinationProfile
from encode_profile import (
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_TARGET_LATENCY_MS,
    build_video_encode_args,
    clamp_target_latency_ms,
    encode_profile_summary,
    with_srt_latency,
)
from endpoint_probe import probe_endpoint
from ingest_host_metrics import IngestHostMetricsPoller
from metrics import MetricsCollector, compute_encode_lag_ms
from moq_publish import (
    BROWSER_COMPAT_AUDIO_ARGS,
    WHIP_COMPAT_AUDIO_ARGS,
    MPEGTS_VIDEO_BSF,
    build_ffmpeg_input_args,
    build_ffmpeg_moq_cmd,
    build_moq_publisher_cmd,
    find_ffmpeg,
    find_moq_publisher,
    is_live_media_source,
    mediamtx_loopback_publish_url,
    with_srt_stream_id,
    zixi_http_push_stream_id_for_preset,
    zixi_srt_stream_id_for_preset,
)
from moqx_stats import MoqxStatsPoller
from path_rtt import PathRttProbe
from picoquic_qlog import PicoquicQlogTailer
from zixi_hls_health import (
    mediamtx_hls_probe_url,
    probe_hls_segment_ready,
    probe_http_ts_ready,
    zixi_hls_playback_url,
)
from zixi_input_reset import remove_zixi_srt_input, reset_zixi_srt_input_with_retry
from zixi_ts_offset import (
    allocate_output_ts_offset,
    ffmpeg_output_ts_offset_args,
    reset_output_ts_offset,
    ts_offset_enabled,
)
from network_metrics import (
    FfmpegProgressFileReader,
    FfmpegProgressReader,
    find_srt_live_transmit,
)
from srt_stats import SrtStatsReader
from system_metrics import read_client_host_metrics
from encoder_capture import (
    build_tee_output_args,
    encoder_capture_path,
    start_moq_capture_tee,
)
from quality_metrics import (
    build_quality_payload,
    quality_leg_from_vmaf_result,
)
from vmaf_score import compute_vmaf
from mediamtx_stats import MediaMtxStatsPoller, MediaMtxStatsSnapshot
from zixi_stats import ZixiStatsPoller

logger = logging.getLogger("MoQ-SRT-Bench")

# After ingest starts, allow this long for Zixi HLS before treating it as wedged.
_HLS_WARMUP_SEC = 5
_HLS_STUCK_SEC = 18
_HLS_STALE_ROLLING_SEC = 24
_HLS_HEAL_ATTEMPTS = 1


def _hls_stuck_threshold_sec(target_latency_ms: int) -> float:
    """Higher target latency legitimately means slower per-chunk cadence.

    Confirmed live 2026-07-19: a job with target_latency_ms=5350 whose own
    CSV showed perfectly steady fps/out_time for its whole ~58s duration
    still tripped this heal (stale sig for 24s+) at ~32s in, tearing down a
    working player. The fixed thresholds were tuned around the ~800-1000ms
    jobs we test with most; a much higher target latency legitimately slows
    Zixi's per-chunk cadence enough to need real headroom here, not just a
    token bump — and Option 1 (error-concealed derived stream) is already
    the seamless fix for the classic reconnect stall this heal exists for,
    so erring toward patience over a disruptive false-positive reconnect is
    the right tradeoff now.
    """
    return max(_HLS_STUCK_SEC, (target_latency_ms / 1000.0) * 6.0)


def _hls_stale_rolling_threshold_sec(target_latency_ms: int) -> float:
    return max(_HLS_STALE_ROLLING_SEC, (target_latency_ms / 1000.0) * 8.0)


@dataclass
class UploadJob:
    media_path: str
    destination: DestinationProfile
    duration_sec: int
    job_id: str = ""
    comparison_id: str = ""
    stream_index: int = 0
    stream_label: str = ""
    compute_vmaf_on_ingest: bool = False
    compute_vmaf_encoder: bool = False
    encode_ladder: str = DEFAULT_ENCODE_LADDER_ID
    target_latency_ms: int = DEFAULT_TARGET_LATENCY_MS
    zixi_stream_id: str = ""
    # Error-concealed derived stream for HLS playback (falls back to
    # zixi_stream_id when concealment isn't configured). See
    # zixi_error_concealment.py.
    zixi_playback_stream_id: str = ""
    ingest_recording_dir: str = ""
    ingest_agent_url: str = ""
    ingest_agent_token: str = ""
    distorted_path: str = ""
    encoder_capture_path: str = ""
    compute_vmaf: bool = False
    cancel_event: Optional[threading.Event] = None
    # JobManager sets this so SRT preview stays gated until HLS segments are readable.
    on_preview_ready: Optional[Callable[[bool], None]] = field(default=None, repr=False)
    # JobManager sets this so the UI can show "computing" the moment the
    # encoder-side VMAF/PSNR/SSIM run actually starts, instead of only ever
    # seeing "waiting for encode" until the whole job (encode + VMAF) is done.
    on_encoder_vmaf_status: Optional[Callable[[str], None]] = field(default=None, repr=False)
    ffmpeg_cmd: List[str] = field(default_factory=list, init=False)
    # Allocated once per job for managed Zixi MPEG-TS (Fast HLS timeline fix).
    _zixi_output_ts_offset_sec: Optional[float] = field(default=None, init=False, repr=False)

    def is_cancelled(self) -> bool:
        return bool(self.cancel_event and self.cancel_event.is_set())

    def __post_init__(self):
        self.target_latency_ms = clamp_target_latency_ms(self.target_latency_ms)
        self.encode_ladder = (self.encode_ladder or DEFAULT_ENCODE_LADDER_ID).strip().lower()
        if not self.ffmpeg_cmd:
            self.ffmpeg_cmd = self._build_ffmpeg_cmd()

    def _video_args(self) -> List[str]:
        return build_video_encode_args(self.encode_ladder, self.target_latency_ms)

    def _uses_zixi_mpegts_output(self) -> bool:
        """True when this encode muxes MPEG-TS toward a managed Zixi SRT input."""
        return self.destination.protocol == "srt" and bool(self.managed_zixi_stream_id())

    def _ensure_zixi_output_ts_offset(self) -> float:
        if self._zixi_output_ts_offset_sec is not None:
            return float(self._zixi_output_ts_offset_sec)
        if not ts_offset_enabled() or not self._uses_zixi_mpegts_output():
            self._zixi_output_ts_offset_sec = 0.0
            return 0.0
        stream_id = self.managed_zixi_stream_id() or ""
        self._zixi_output_ts_offset_sec = allocate_output_ts_offset(
            stream_id,
            duration_sec=self.duration_sec,
        )
        return float(self._zixi_output_ts_offset_sec)

    def _build_ffmpeg_cmd(
        self,
        *,
        progress_path: str = "pipe:1",
        udp_url: str = "",
        capture_path: str = "",
    ) -> List[str]:
        if capture_path:
            if udp_url:
                network_url = udp_url
            elif self.destination.protocol == "srt":
                network_url = self._resolved_srt_destination_url()
            else:
                network_url = self.destination.url
                if self._is_mediamtx_destination():
                    network_url = mediamtx_loopback_publish_url(network_url)
            output_args = build_tee_output_args(
                self.destination.protocol,
                network_url,
                capture_path,
            )
        elif udp_url:
            output_args = ["-bsf:v", MPEGTS_VIDEO_BSF, "-f", "mpegts", udp_url]
        else:
            output_args = self._browser_compat_output_args()
        offset_args: List[str] = []
        if self._uses_zixi_mpegts_output():
            offset_args = ffmpeg_output_ts_offset_args(self._ensure_zixi_output_ts_offset())
        audio_args = (
            WHIP_COMPAT_AUDIO_ARGS
            if self.destination.protocol == "webrtc"
            else BROWSER_COMPAT_AUDIO_ARGS
        )
        return [
            find_ffmpeg(),
            *build_ffmpeg_input_args(self.media_path, duration_sec=self.duration_sec),
            *self._video_args(),
            *audio_args,
            "-progress",
            progress_path,
            "-nostats",
            *offset_args,
            *output_args,
        ]

    def _is_mediamtx_destination(self) -> bool:
        return (self.destination.ingest_provider or "").strip().lower() == "gcp_mediamtx"

    def _browser_compat_output_args(self) -> List[str]:
        if self.destination.protocol == "srt":
            return [
                "-bsf:v",
                MPEGTS_VIDEO_BSF,
                "-f",
                "mpegts",
                self._resolved_srt_destination_url(),
            ]
        args = list(self.destination.ffmpeg_output_args())
        if self._is_mediamtx_destination() and args:
            # Last arg is the publish URL for RTMP / WHIP muxers.
            args[-1] = mediamtx_loopback_publish_url(str(args[-1]))
        return args

    def managed_zixi_stream_id(self) -> Optional[str]:
        """Zixi SRT input stream ID for publish + HLS.

        Prefer an explicit job.zixi_stream_id when set (legacy per-job ids);
        otherwise the preset shared default ("SRT Test" for GCP Zixi).
        """
        return self.zixi_stream_id or zixi_srt_stream_id_for_preset(self.destination.preset_id)

    def _resolved_srt_destination_url(self) -> str:
        url = self.destination.url
        stream_id = self.managed_zixi_stream_id()
        if stream_id:
            url = with_srt_stream_id(url, stream_id)
        # Cap MediaMTX SRT latency for LL-HLS — multi-second caller latency
        # delays the first playlist and fights low-latency delivery.
        latency_ms = self.target_latency_ms
        if self._is_mediamtx_destination():
            latency_ms = min(int(latency_ms), 1000)
        url = with_srt_latency(url, latency_ms)
        if self._is_mediamtx_destination():
            url = mediamtx_loopback_publish_url(url)
        return url


@dataclass
class UploadSample:
    elapsed_sec: int
    encoded_bitrate_kbps: float
    fps: float
    fps_stability: float
    speed: float
    out_time: str
    cpu_percent: float
    memory_mb: float
    progress: str
    transport_rtt_ms: float = 0.0
    transport_rtt_jitter_ms: float = 0.0
    net_rtt_ms: float = 0.0
    net_jitter_ms: float = 0.0
    net_send_mbps: float = 0.0
    net_recv_mbps: float = 0.0
    net_loss_pct: float = 0.0
    net_retrans_pct: float = 0.0
    encode_lag_ms: float = 0.0
    e2e_latency_ms: float = 0.0
    playback_error_count: int = 0
    pkt_rcv_drop: int = 0
    pkt_snd_drop: int = 0
    pkt_snd_loss: int = 0
    pkt_retrans: int = 0
    pkt_fec_extra: int = 0
    ts_continuity_counter_errors: int = 0
    vmaf_score: Optional[float] = None
    psnr_db: Optional[float] = None
    ssim: Optional[float] = None
    encoder_send_rate_mbps: float = 0.0
    transport_recv_rate_mbps: float = 0.0
    client_memory_percent: float = 0.0
    client_disk_percent: float = 0.0
    server_cpu_percent: float = 0.0
    server_memory_percent: float = 0.0
    server_disk_percent: float = 0.0
    moqx_subscribe_success: int = 0
    moqx_subscribe_error: int = 0
    moqx_publish_namespace_success: int = 0
    moqx_publish_received: int = 0
    moqx_publish_done: int = 0
    quic_rtt_ms: float = 0.0
    quic_cwnd_bytes: int = 0
    quic_packets_lost: int = 0


@dataclass
class UploadResult:
    success: bool
    csv_path: Optional[str] = None
    summary_path: Optional[str] = None
    vmaf_score: Optional[float] = None
    psnr_db: Optional[float] = None
    ssim: Optional[float] = None
    encoder_vmaf_status: str = "disabled"
    encoder_vmaf_score: Optional[float] = None
    encoder_psnr_db: Optional[float] = None
    encoder_ssim: Optional[float] = None
    encoder_vmaf_error: Optional[str] = None
    error: Optional[str] = None


SampleCallback = Callable[[UploadSample], None]


def _pick_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class UploadService:
    # Zixi's SRT push input is a single shared listener (one port per input
    # object; see zixi_input_reset.py). Per-job stream IDs stop two runs from
    # reusing the same input object, but they still can't both bind that port
    # at once, so overlapping SRT jobs are serialized here instead of racing
    # add_stream/remove_stream calls against each other.
    _zixi_srt_ingest_lock = threading.Lock()

    def run(
        self,
        job: UploadJob,
        on_sample: Optional[SampleCallback] = None,
    ) -> UploadResult:
        if job.destination.protocol == "srt":
            if job.managed_zixi_stream_id():
                logger.info(
                    "Waiting for exclusive access to shared Zixi SRT ingest (job %s)...",
                    job.job_id,
                )
                while True:
                    if job.is_cancelled():
                        return UploadResult(
                            success=False,
                            error="Cancelled while waiting for exclusive SRT ingest access",
                        )
                    acquired = self._zixi_srt_ingest_lock.acquire(timeout=1.0)
                    if acquired:
                        break
                logger.info("Acquired Zixi SRT ingest for job %s.", job.job_id)
                try:
                    return self._run_srt_pipeline(job, on_sample=on_sample)
                finally:
                    self._zixi_srt_ingest_lock.release()
                    # Defer Zixi input deletion until after JobManager marks the job
                    # completed/failed so the browser can flip playbackGate→ended and
                    # destroy HLS before the playlist 404s. See cleanup_zixi_srt_input_if_managed.
            return self._run_srt_pipeline(job, on_sample=on_sample)
        if job.destination.protocol == "moq":
            return self._run_moq_pipeline(job, on_sample=on_sample)
        return self._run_direct_ffmpeg(job, on_sample=on_sample)

    def _run_direct_ffmpeg(
        self,
        job: UploadJob,
        on_sample: Optional[SampleCallback] = None,
    ) -> UploadResult:
        if job.destination.protocol in {"rtmp", "hls", "dash"}:
            ok, probe_error = probe_endpoint(
                job.destination.protocol,
                job.destination.url,
                job.media_path,
            )
            if not ok:
                return UploadResult(success=False, error=probe_error)

        process: Optional[subprocess.Popen] = None
        progress_reader: Optional[FfmpegProgressReader] = None
        temp_dir = ""
        ffmpeg_cmd = job.ffmpeg_cmd

        if job.compute_vmaf_encoder:
            temp_dir = tempfile.mkdtemp(prefix="moq-bench-")
            job.encoder_capture_path = encoder_capture_path(
                temp_dir,
                job.destination.protocol,
            )
            ffmpeg_cmd = job._build_ffmpeg_cmd(capture_path=job.encoder_capture_path)

        stop_preview = threading.Event()
        if self._managed_hls_manifest_url(job):
            self._notify_preview_ready(job, False)
            threading.Thread(
                target=self._watch_hls_preview_until_ready,
                args=(job, stop_preview),
                daemon=True,
                name=f"hls-preview-{job.job_id[:8]}",
            ).start()

        try:
            process = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            stop_preview.set()
            return UploadResult(success=False, error="ffmpeg not found in PATH")

        progress_reader = FfmpegProgressReader(process.stdout)
        zixi_stats_url = (
            job._resolved_srt_destination_url()
            if job.destination.protocol == "srt"
            else job.destination.url
        )
        collector = MetricsCollector(
            protocol=job.destination.protocol,
            endpoint_url=zixi_stats_url,
            run_id=job.job_id,
        )
        zixi_poller = ZixiStatsPoller(
            zixi_stats_url,
            enabled=False if self._is_mediamtx_destination(job) else None,
        )
        mtx_poller = self._mediamtx_poller_for_job(job)
        ingest_poller = IngestHostMetricsPoller(
            job.destination.url,
            agent_url=job.ingest_agent_url,
            ingest_provider=job.destination.ingest_provider,
        )
        # RTMP has no libsrt RTT; prefer Zixi/MediaMTX receiver stats when available,
        # otherwise TCP-connect probe to the RTMP host:port as net_rtt / jitter.
        path_rtt_probe: Optional[PathRttProbe] = None
        if job.destination.protocol == "rtmp":
            rtmp_parsed = urlparse(job.destination.url)
            path_rtt_probe = PathRttProbe(
                job.destination.url,
                port=rtmp_parsed.port or 1935,
            )
        elif job.destination.protocol == "webrtc" and mtx_poller:
            # WHIP HTTP control plane — TCP probe as RTT fallback when WebRTC has no RTT metric.
            whip_parsed = urlparse(job.destination.url)
            path_rtt_probe = PathRttProbe(
                job.destination.url,
                port=whip_parsed.port or 8889,
            )
        start_time = time.time()

        try:
            while time.time() - start_time < job.duration_sec:
                if job.is_cancelled():
                    logger.info("Upload job %s cancelled by user", job.job_id)
                    break
                if process.poll() is not None:
                    if process.returncode == 0:
                        # Source ended cleanly before wall-clock duration — finalize + VMAF.
                        break
                    return UploadResult(
                        success=False,
                        error=self._ffmpeg_failure_message(process),
                    )

                status = progress_reader.get_status()
                zixi_stats = zixi_poller.poll()
                mtx_stats = mtx_poller.poll() if mtx_poller else MediaMtxStatsSnapshot()
                path_rtt = path_rtt_probe.poll() if path_rtt_probe and path_rtt_probe.enabled else None
                client_host = read_client_host_metrics()
                server_host = ingest_poller.poll() if ingest_poller.enabled else None
                elapsed = int(time.time() - start_time)
                cpu, mem = self._process_usage([process.pid])
                send_mbps = status.bitrate_kbps / 1000.0
                encoded_bitrate_kbps = status.bitrate_kbps or (send_mbps * 1000.0)
                encode_lag_ms = compute_encode_lag_ms(float(elapsed), status.out_time)
                merged = self._merge_mediamtx_transport(
                    mtx=mtx_stats,
                    net_rtt_ms=zixi_stats.rtt_ms or (path_rtt.rtt_ms if path_rtt else 0.0),
                    net_jitter_ms=zixi_stats.jitter_ms or (path_rtt.jitter_ms if path_rtt else 0.0),
                    net_send_mbps=send_mbps,
                    net_recv_mbps=0.0,
                    net_loss_pct=zixi_stats.packet_loss_pct,
                    ts_continuity_counter_errors=zixi_stats.cc_errors,
                )

                sample = UploadSample(
                    elapsed_sec=elapsed,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    fps_stability=0.0,
                    speed=status.speed,
                    out_time=status.out_time,
                    cpu_percent=cpu,
                    memory_mb=mem,
                    progress=status.progress,
                    transport_rtt_ms=merged["net_rtt_ms"],
                    transport_rtt_jitter_ms=merged["net_jitter_ms"],
                    net_rtt_ms=merged["net_rtt_ms"],
                    net_jitter_ms=merged["net_jitter_ms"],
                    net_send_mbps=merged["net_send_mbps"],
                    net_recv_mbps=merged["net_recv_mbps"],
                    net_loss_pct=merged["net_loss_pct"],
                    net_retrans_pct=merged["net_retrans_pct"],
                    encode_lag_ms=encode_lag_ms,
                    pkt_rcv_drop=merged["pkt_rcv_drop"],
                    pkt_snd_drop=merged["pkt_snd_drop"],
                    pkt_snd_loss=merged["pkt_snd_loss"],
                    pkt_retrans=merged["pkt_retrans"],
                    ts_continuity_counter_errors=merged["ts_continuity_counter_errors"],
                    encoder_send_rate_mbps=merged["net_send_mbps"],
                    transport_recv_rate_mbps=merged["net_recv_mbps"],
                    client_memory_percent=client_host.memory_percent,
                    client_disk_percent=client_host.disk_percent,
                    server_cpu_percent=server_host.cpu_percent if server_host else 0.0,
                    server_memory_percent=server_host.memory_percent if server_host else 0.0,
                    server_disk_percent=server_host.disk_percent if server_host else 0.0,
                )
                sample.fps_stability = collector.record_sample(
                    pid=process.pid,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                    transport_rtt_ms=sample.transport_rtt_ms,
                    transport_rtt_jitter_ms=sample.transport_rtt_jitter_ms,
                    pkt_rcv_drop=sample.pkt_rcv_drop,
                    pkt_snd_drop=sample.pkt_snd_drop,
                    pkt_snd_loss=sample.pkt_snd_loss,
                    pkt_retrans=sample.pkt_retrans,
                    ts_continuity_counter_errors=sample.ts_continuity_counter_errors,
                    encoder_send_rate_mbps=sample.encoder_send_rate_mbps,
                    transport_recv_rate_mbps=sample.transport_recv_rate_mbps,
                    encode_lag_ms=encode_lag_ms,
                    net_rtt_ms=sample.net_rtt_ms,
                    net_jitter_ms=sample.net_jitter_ms,
                    net_send_mbps=sample.net_send_mbps,
                    net_recv_mbps=sample.net_recv_mbps,
                    net_loss_pct=sample.net_loss_pct,
                    net_retrans_pct=sample.net_retrans_pct,
                    client_memory_percent=sample.client_memory_percent,
                    client_disk_percent=sample.client_disk_percent,
                    server_cpu_percent=sample.server_cpu_percent,
                    server_memory_percent=sample.server_memory_percent,
                    server_disk_percent=sample.server_disk_percent,
                )

                if on_sample:
                    on_sample(sample)
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Upload interrupted.")
            return UploadResult(success=False, error="Upload interrupted")
        finally:
            stop_preview.set()
            self._terminate_process(process)

        return self._finalize_result(
            job,
            collector,
            zixi_enabled=zixi_poller.enabled,
            server_metrics_enabled=ingest_poller.enabled,
        )

    def _notify_preview_ready(self, job: UploadJob, ready: bool) -> None:
        callback = job.on_preview_ready
        if not callback:
            return
        try:
            callback(ready)
        except Exception:
            logger.warning("on_preview_ready callback failed", exc_info=True)

    def _is_mediamtx_destination(self, job: UploadJob) -> bool:
        return (job.destination.ingest_provider or "").strip().lower() == "gcp_mediamtx"

    def _mediamtx_poller_for_job(self, job: UploadJob) -> Optional[MediaMtxStatsPoller]:
        if not self._is_mediamtx_destination(job):
            return None
        return MediaMtxStatsPoller(endpoint_url=job.destination.url)

    @staticmethod
    def _merge_mediamtx_transport(
        *,
        mtx: MediaMtxStatsSnapshot,
        net_rtt_ms: float,
        net_jitter_ms: float,
        net_send_mbps: float,
        net_recv_mbps: float,
        net_loss_pct: float = 0.0,
        net_retrans_pct: float = 0.0,
        pkt_rcv_drop: int = 0,
        pkt_snd_drop: int = 0,
        pkt_snd_loss: int = 0,
        pkt_retrans: int = 0,
        ts_continuity_counter_errors: int = 0,
    ) -> dict:
        """Prefer publisher libsrt when present; fill gaps from MediaMTX receiver stats."""
        return {
            "net_rtt_ms": net_rtt_ms or mtx.net_rtt_ms,
            "net_jitter_ms": net_jitter_ms or mtx.net_jitter_ms,
            # Send = publisher→network (libsrt/ffmpeg). If missing, approximate with
            # MediaMTX ingest receive rate. mtx.net_send_mbps is egress to readers.
            "net_send_mbps": net_send_mbps or mtx.net_recv_mbps,
            "net_recv_mbps": net_recv_mbps or mtx.net_recv_mbps,
            "net_loss_pct": net_loss_pct or mtx.net_loss_pct,
            "net_retrans_pct": net_retrans_pct or mtx.net_retrans_pct,
            "pkt_rcv_drop": pkt_rcv_drop or mtx.pkt_rcv_drop,
            "pkt_snd_drop": pkt_snd_drop or mtx.pkt_snd_drop,
            "pkt_snd_loss": pkt_snd_loss or mtx.pkt_snd_loss,
            "pkt_retrans": pkt_retrans or mtx.pkt_retrans,
            "ts_continuity_counter_errors": (
                ts_continuity_counter_errors or mtx.ts_continuity_counter_errors
            ),
        }

    def _managed_hls_manifest_url(self, job: UploadJob) -> Optional[str]:
        if self._is_mediamtx_destination(job):
            # Probe via loopback; public playback URLs stay in the SPA/proxy.
            return mediamtx_hls_probe_url("benchmark")
        stream_id = job.managed_zixi_stream_id()
        if not stream_id:
            return None
        # Watch the same error-concealed stream the browser plays (when
        # available) so our own preview-ready gating / heal detection can't
        # disagree with what's actually on screen.
        playback_stream_id = job.zixi_playback_stream_id or stream_id
        return zixi_hls_playback_url(playback_stream_id, endpoint_url=job.destination.url)

    def _managed_http_ts_stream_id(self, job: UploadJob) -> Optional[str]:
        if (job.destination.ingest_provider or "").strip().lower() != "gcp_zixi":
            return None
        if job.destination.protocol not in {"hls", "dash"}:
            return None
        return zixi_http_push_stream_id_for_preset(job.destination.preset_id) or "benchmark"

    def _reset_zixi_srt_input_if_managed(self, job: UploadJob) -> bool:
        """Delete+recreate the Zixi SRT push input (fresh Fast HLS packager).

        Returns True only when the reset is verified. Used as heal/fallback and
        when ZIXI_SRT_RESET_BEFORE_PUBLISH=1; normal publishes rely on
        ``-output_ts_offset`` instead.
        """
        stream_id = job.managed_zixi_stream_id()
        if not stream_id:
            return True
        try:
            port = urlparse(job.destination.url).port or 10080
        except ValueError:
            port = 10080
        try:
            ok = reset_zixi_srt_input_with_retry(
                stream_id,
                port=port,
                attempts=2,
                srt_latency_ms=job.target_latency_ms,
                max_bitrate_kbps=encode_profile_summary(
                    job.encode_ladder, job.target_latency_ms
                )["maxrate_kbps"],
            )
        except Exception:
            logger.exception("Zixi SRT input reset raised for '%s'", stream_id)
            return False
        if not ok:
            logger.error(
                "Zixi SRT input reset failed for '%s' after retries.",
                stream_id,
            )
            return False
        # New packager starts at timeline zero — restart the publisher offset counter.
        reset_output_ts_offset(stream_id)
        job._zixi_output_ts_offset_sec = None
        return True

    def cleanup_zixi_srt_input_if_managed(self, job: UploadJob) -> None:
        """Public wrapper so JobManager can delete the stream after gate=ended."""
        self._cleanup_zixi_srt_input_if_managed(job)

    def _cleanup_zixi_srt_input_if_managed(self, job: UploadJob) -> None:
        """Delete ephemeral per-job Zixi SRT inputs after push.

        Shared preset streams like "SRT Test" are left in place (reset before
        the next push). Only legacy job-* ids are removed so the stream table
        does not accumulate orphans.
        """
        stream_id = (job.zixi_stream_id or "").strip()
        if not stream_id.startswith("job-"):
            return
        try:
            remove_zixi_srt_input(stream_id)
        except Exception:
            logger.warning(
                "Zixi SRT input cleanup failed for '%s'; it may linger until the next reset.",
                stream_id,
                exc_info=True,
            )

    def _watch_hls_preview_until_ready(
        self,
        job: UploadJob,
        stop_event: threading.Event,
    ) -> None:
        """Mark preview_ready once delivery media is readable.

        MediaMTX → API/metrics path-ready (avoid slow LL-HLS probes).
        Zixi SRT → HLS segment probe. TS-PUT → HTTP-TS when configured.
        """
        if self._is_mediamtx_destination(job):
            poller = MediaMtxStatsPoller(endpoint_url=job.destination.url)
            probe_url = mediamtx_hls_probe_url("benchmark")
            while not stop_event.is_set():
                snap = poller.poll()
                if snap.ready or snap.net_recv_mbps > 0 or snap.bytes_received > 0:
                    self._notify_preview_ready(job, True)
                    return
                # Short LL-HLS probe as a last resort (loopback, 2s timeout).
                try:
                    if probe_hls_segment_ready(probe_url, timeout=2.0).ok:
                        self._notify_preview_ready(job, True)
                        return
                except Exception:
                    logger.debug("MediaMTX HLS preview probe failed", exc_info=True)
                stop_event.wait(0.5)
            return
        http_ts_id = self._managed_http_ts_stream_id(job)
        if http_ts_id:
            while not stop_event.is_set():
                if probe_http_ts_ready(http_ts_id, endpoint_url=job.destination.url).ok:
                    self._notify_preview_ready(job, True)
                    return
                stop_event.wait(1.0)
            return
        manifest_url = self._managed_hls_manifest_url(job)
        if not manifest_url:
            # No gated delivery path — allow UI immediately (e.g. custom endpoints).
            self._notify_preview_ready(job, True)
            return
        while not stop_event.is_set():
            if probe_hls_segment_ready(manifest_url).ok:
                self._notify_preview_ready(job, True)
                return
            stop_event.wait(1.0)

    def _heal_srt_live_transmit(
        self,
        job: UploadJob,
        *,
        srt_proc: Optional[subprocess.Popen],
        srt_cmd: List[str],
    ) -> tuple[Optional[subprocess.Popen], Optional[str]]:
        """Stop SRT push, reset Zixi input, reconnect once. Keeps ffmpeg/UDP running."""
        logger.warning(
            "HLS preview wedged for job %s — attempting one SRT reconnect heal...",
            job.job_id,
        )
        self._notify_preview_ready(job, False)
        self._terminate_process(srt_proc)
        # Brief pause so Zixi drops the previous source before recreate.
        time.sleep(0.5)
        if not self._reset_zixi_srt_input_if_managed(job):
            return None, (
                "Zixi SRT input reset failed during HLS heal; "
                "preview cannot recover for this job"
            )
        try:
            new_proc = subprocess.Popen(
                srt_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except OSError as exc:
            return None, f"Failed to restart srt-live-transmit during HLS heal: {exc}"
        return new_proc, None

    def _run_srt_pipeline(
        self,
        job: UploadJob,
        on_sample: Optional[SampleCallback] = None,
    ) -> UploadResult:
        """Push MPEG-TS to Zixi over SRT.

        Prefer srt-live-transmit when available (libsrt pkt_* / send-rate CSV stats).
        Set SRT_USE_LIVE_TRANSMIT=0 to force native ffmpeg→SRT.
        Set SRT_USE_LIVE_TRANSMIT=1 to require live-transmit (error if missing).

        Managed Zixi SRT publishes use monotonic ``-output_ts_offset`` so Fast HLS
        does not stall on file republish. Delete+recreate is heal/fallback only
        (set ZIXI_SRT_RESET_BEFORE_PUBLISH=1 to force the old preflight).
        """
        reset_flag = os.environ.get("ZIXI_SRT_RESET_BEFORE_PUBLISH", "").strip().lower()
        if job.managed_zixi_stream_id() and reset_flag in {"1", "true", "yes"}:
            if not self._reset_zixi_srt_input_if_managed(job):
                return UploadResult(
                    success=False,
                    error=(
                        "Zixi SRT input could not be verified after delete+recreate "
                        "(ZIXI_SRT_RESET_BEFORE_PUBLISH=1). "
                        "Check ZIXI_API_* credentials and that nothing else is connected to "
                        f"'{job.managed_zixi_stream_id()}'."
                    ),
                )

        live_transmit_flag = os.environ.get("SRT_USE_LIVE_TRANSMIT", "").strip().lower()
        srt_bin = find_srt_live_transmit()
        use_live_transmit = live_transmit_flag in {"1", "true", "yes"} or (
            live_transmit_flag not in {"0", "false", "no"} and bool(srt_bin)
        )
        # MediaMTX: ffmpeg→UDP→srt-live-transmit connects SRT but delivers no
        # media (path stays empty, LL-HLS 404). Direct ffmpeg→SRT works; receiver
        # stats still come from MediaMTX Prometheus.
        if self._is_mediamtx_destination(job):
            if use_live_transmit:
                logger.info(
                    "MediaMTX SRT job %s: using direct ffmpeg→SRT (skipping srt-live-transmit)",
                    job.job_id,
                )
            use_live_transmit = False

        if not use_live_transmit or not srt_bin:
            if live_transmit_flag in {"1", "true", "yes"} and not srt_bin:
                return UploadResult(
                    success=False,
                    error="SRT_USE_LIVE_TRANSMIT=1 but srt-live-transmit was not found in PATH",
                )
            resolved = job._resolved_srt_destination_url()
            ffmpeg_bin = find_ffmpeg()
            if not shutil.which(ffmpeg_bin) and not os.path.isfile(ffmpeg_bin):
                return UploadResult(success=False, error="ffmpeg not found in PATH")
            try:
                probe = subprocess.run(
                    [ffmpeg_bin, "-protocols"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                if "srt" not in (probe.stdout or "").split():
                    return UploadResult(
                        success=False,
                        error=(
                            f"{ffmpeg_bin} lacks SRT support. Install ffmpeg-full "
                            "(brew install ffmpeg-full) and restart ./scripts/dev.sh"
                        ),
                    )
            except (OSError, subprocess.TimeoutExpired):
                pass
            logger.info("SRT destination (direct ffmpeg): %s", resolved)
            stop_preview = threading.Event()
            threading.Thread(
                target=self._watch_hls_preview_until_ready,
                args=(job, stop_preview),
                daemon=True,
                name=f"hls-preview-{job.job_id[:8]}",
            ).start()
            try:
                return self._run_direct_ffmpeg(job, on_sample=on_sample)
            finally:
                stop_preview.set()

        udp_port = _pick_udp_port()
        udp_url = f"udp://127.0.0.1:{udp_port}?pkt_size=1316"
        temp_dir = tempfile.mkdtemp(prefix="moq-bench-")
        progress_path = os.path.join(temp_dir, "ffmpeg-progress.txt")
        stats_path = os.path.join(temp_dir, "srt-stats.csv")

        capture_path = ""
        if job.compute_vmaf_encoder:
            job.encoder_capture_path = encoder_capture_path(temp_dir, job.destination.protocol)
            capture_path = job.encoder_capture_path

        ffmpeg_cmd = job._build_ffmpeg_cmd(
            progress_path=progress_path,
            udp_url=udp_url,
            capture_path=capture_path,
        )
        srt_cmd = [
            srt_bin,
            "-statsout:" + stats_path,
            "-statspf:csv",
            "-s:50",
            f"udp://:@127.0.0.1:{udp_port}",
            job._resolved_srt_destination_url(),
        ]

        ffmpeg_proc: Optional[subprocess.Popen] = None
        srt_proc: Optional[subprocess.Popen] = None
        # Live-transmit path previously skipped the preview watcher — the sample
        # loop alone could not open the player when host-metric polls stalled.
        stop_preview = threading.Event()
        if self._managed_hls_manifest_url(job) or self._is_mediamtx_destination(job):
            self._notify_preview_ready(job, False)
            threading.Thread(
                target=self._watch_hls_preview_until_ready,
                args=(job, stop_preview),
                daemon=True,
                name=f"hls-preview-{job.job_id[:8]}",
            ).start()

        try:
            ffmpeg_proc = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            time.sleep(0.5)
            srt_proc = subprocess.Popen(
                srt_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except FileNotFoundError:
            stop_preview.set()
            self._terminate_process(ffmpeg_proc)
            return UploadResult(success=False, error="ffmpeg not found in PATH")

        progress_reader = FfmpegProgressFileReader(progress_path)
        srt_reader = SrtStatsReader(stats_path)
        resolved_srt_url = job._resolved_srt_destination_url()
        logger.info("SRT destination: %s", resolved_srt_url)
        collector = MetricsCollector(
            protocol=job.destination.protocol,
            endpoint_url=resolved_srt_url,
            run_id=job.job_id,
        )
        # Zixi API lookups on MediaMTX streamids (publish:benchmark) hang and
        # stall the sample loop — only poll Zixi for managed Zixi SRT.
        zixi_poller = ZixiStatsPoller(
            resolved_srt_url,
            enabled=False if self._is_mediamtx_destination(job) else None,
        )
        mtx_poller = self._mediamtx_poller_for_job(job)
        ingest_poller = IngestHostMetricsPoller(
            job.destination.url,
            agent_url=job.ingest_agent_url,
            ingest_provider=job.destination.ingest_provider,
        )
        start_time = time.time()
        manifest_url = self._managed_hls_manifest_url(job)
        preview_ready = False
        bad_since: Optional[float] = None
        rolling_sig: Optional[tuple] = None
        rolling_since: Optional[float] = None
        heals_used = 0

        try:
            while time.time() - start_time < job.duration_sec:
                if job.is_cancelled():
                    logger.info("SRT upload job %s cancelled by user", job.job_id)
                    break
                if ffmpeg_proc.poll() is not None:
                    if ffmpeg_proc.returncode == 0:
                        # Media EOF before wall-clock duration — still finalize so VMAF runs.
                        logger.info("ffmpeg finished cleanly before duration; finalizing SRT job")
                        break
                    return UploadResult(
                        success=False,
                        error=self._ffmpeg_failure_message(ffmpeg_proc),
                    )
                if srt_proc is not None and srt_proc.poll() is not None and srt_proc.returncode not in (0, None):
                    stderr = ""
                    if srt_proc.stderr:
                        stderr = srt_proc.stderr.read().decode("utf-8", errors="replace").strip()
                    detail = stderr.splitlines()[-1] if stderr else "unknown error"
                    return UploadResult(
                        success=False,
                        error=f"srt-live-transmit exited with code {srt_proc.returncode}: {detail}",
                    )

                elapsed = int(time.time() - start_time)
                is_mediamtx = self._is_mediamtx_destination(job)

                status = progress_reader.get_status()
                srt_stats = srt_reader.poll()
                zixi_stats = zixi_poller.poll()
                mtx_stats = mtx_poller.poll() if mtx_poller else MediaMtxStatsSnapshot()
                # MediaMTX: open the player from path/encode signals only.
                # Do not HLS-probe here — nested LL-HLS fetches were blocking the
                # sample loop (~10s) and Zixi-style heal must never run on MTX.
                if is_mediamtx and not preview_ready and elapsed >= 2:
                    if (
                        mtx_stats.ready
                        or mtx_stats.net_recv_mbps > 0
                        or mtx_stats.bytes_received > 0
                    ):
                        logger.info(
                            "MediaMTX preview ready for job %s (ready=%s recv_mbps=%.3f bytes=%s)",
                            job.job_id,
                            mtx_stats.ready,
                            mtx_stats.net_recv_mbps,
                            mtx_stats.bytes_received,
                        )
                        self._notify_preview_ready(job, True)
                        preview_ready = True

                # Zixi Fast HLS only: gate on segment readiness; auto-heal once if wedged.
                if (
                    manifest_url
                    and elapsed >= _HLS_WARMUP_SEC
                    and not is_mediamtx
                ):
                    try:
                        health = probe_hls_segment_ready(manifest_url)
                    except Exception:
                        logger.warning(
                            "HLS health probe raised unexpectedly for job %s",
                            job.job_id,
                            exc_info=True,
                        )
                        health = None
                    now = time.time()
                    if health is not None and health.ok:
                        bad_since = None
                        sig = (health.media_sequence, health.segment_uri)
                        if sig != rolling_sig:
                            rolling_sig = sig
                            rolling_since = now
                        if not preview_ready:
                            logger.info(
                                "HLS preview ready for job %s (%s)",
                                job.job_id,
                                health.detail,
                            )
                            self._notify_preview_ready(job, True)
                            preview_ready = True
                        stale_rolling = (
                            not is_mediamtx
                            and rolling_since is not None
                            and (now - rolling_since)
                            >= _hls_stale_rolling_threshold_sec(job.target_latency_ms)
                            and health.depth <= 1
                        )
                        if stale_rolling and heals_used < _HLS_HEAL_ATTEMPTS:
                            srt_proc, heal_error = self._heal_srt_live_transmit(
                                job, srt_proc=srt_proc, srt_cmd=srt_cmd
                            )
                            heals_used += 1
                            preview_ready = False
                            bad_since = None
                            rolling_sig = None
                            rolling_since = None
                            if heal_error:
                                return UploadResult(success=False, error=heal_error)
                    elif not is_mediamtx:
                        if bad_since is None:
                            bad_since = now
                        elif (
                            now - bad_since
                        ) >= _hls_stuck_threshold_sec(
                            job.target_latency_ms
                        ) and heals_used < _HLS_HEAL_ATTEMPTS:
                            srt_proc, heal_error = self._heal_srt_live_transmit(
                                job, srt_proc=srt_proc, srt_cmd=srt_cmd
                            )
                            heals_used += 1
                            preview_ready = False
                            bad_since = None
                            rolling_sig = None
                            rolling_since = None
                            if heal_error:
                                return UploadResult(success=False, error=heal_error)
                client_host = read_client_host_metrics()
                server_host = ingest_poller.poll() if ingest_poller.enabled else None
                pids = [pid for pid in (ffmpeg_proc.pid, srt_proc.pid if srt_proc else None) if pid]
                cpu, mem = self._process_usage(pids)

                send_mbps = srt_stats.mbps_send_rate or (status.bitrate_kbps / 1000.0)
                # ffmpeg -progress often reports bitrate=N/A for mpegts/UDP tee; use libsrt send rate.
                encoded_bitrate_kbps = status.bitrate_kbps or (send_mbps * 1000.0)
                encode_lag_ms = compute_encode_lag_ms(float(elapsed), status.out_time)
                # Publisher libsrt first; MediaMTX fills receiver RTT/loss/recv rate (and Zixi if any).
                merged = self._merge_mediamtx_transport(
                    mtx=mtx_stats,
                    net_rtt_ms=srt_stats.rtt_ms or zixi_stats.rtt_ms,
                    net_jitter_ms=srt_stats.rtt_jitter_ms or zixi_stats.jitter_ms,
                    net_send_mbps=send_mbps,
                    net_recv_mbps=srt_stats.mbps_recv_rate,
                    net_loss_pct=zixi_stats.packet_loss_pct,
                    pkt_rcv_drop=srt_stats.pkt_rcv_drop,
                    pkt_snd_drop=srt_stats.pkt_snd_drop,
                    pkt_snd_loss=srt_stats.pkt_snd_loss,
                    pkt_retrans=srt_stats.pkt_retrans,
                    ts_continuity_counter_errors=zixi_stats.cc_errors,
                )
                transport_rtt_ms = merged["net_rtt_ms"]
                transport_rtt_jitter_ms = merged["net_jitter_ms"]

                sample = UploadSample(
                    elapsed_sec=elapsed,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    fps_stability=0.0,
                    speed=status.speed,
                    out_time=status.out_time,
                    cpu_percent=cpu,
                    memory_mb=mem,
                    progress=status.progress,
                    transport_rtt_ms=transport_rtt_ms,
                    transport_rtt_jitter_ms=transport_rtt_jitter_ms,
                    net_rtt_ms=merged["net_rtt_ms"],
                    net_jitter_ms=merged["net_jitter_ms"],
                    net_send_mbps=merged["net_send_mbps"],
                    net_recv_mbps=merged["net_recv_mbps"],
                    net_loss_pct=merged["net_loss_pct"],
                    net_retrans_pct=merged["net_retrans_pct"],
                    encode_lag_ms=encode_lag_ms,
                    pkt_rcv_drop=merged["pkt_rcv_drop"],
                    pkt_snd_drop=merged["pkt_snd_drop"],
                    pkt_snd_loss=merged["pkt_snd_loss"],
                    pkt_retrans=merged["pkt_retrans"],
                    pkt_fec_extra=srt_stats.pkt_fec_extra,
                    ts_continuity_counter_errors=merged["ts_continuity_counter_errors"],
                    encoder_send_rate_mbps=merged["net_send_mbps"],
                    transport_recv_rate_mbps=merged["net_recv_mbps"],
                    client_memory_percent=client_host.memory_percent,
                    client_disk_percent=client_host.disk_percent,
                    server_cpu_percent=server_host.cpu_percent if server_host else 0.0,
                    server_memory_percent=server_host.memory_percent if server_host else 0.0,
                    server_disk_percent=server_host.disk_percent if server_host else 0.0,
                )
                sample.fps_stability = collector.record_sample(
                    pid=ffmpeg_proc.pid,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                    extra_pids=[srt_proc.pid] if srt_proc else None,
                    transport_rtt_ms=transport_rtt_ms,
                    transport_rtt_jitter_ms=transport_rtt_jitter_ms,
                    pkt_rcv_drop=sample.pkt_rcv_drop,
                    pkt_snd_drop=sample.pkt_snd_drop,
                    pkt_snd_loss=sample.pkt_snd_loss,
                    pkt_retrans=sample.pkt_retrans,
                    pkt_fec_extra=sample.pkt_fec_extra,
                    ts_continuity_counter_errors=sample.ts_continuity_counter_errors,
                    encoder_send_rate_mbps=sample.encoder_send_rate_mbps,
                    transport_recv_rate_mbps=sample.transport_recv_rate_mbps,
                    encode_lag_ms=encode_lag_ms,
                    net_rtt_ms=sample.net_rtt_ms,
                    net_jitter_ms=sample.net_jitter_ms,
                    net_send_mbps=sample.net_send_mbps,
                    net_recv_mbps=sample.net_recv_mbps,
                    net_loss_pct=sample.net_loss_pct,
                    net_retrans_pct=sample.net_retrans_pct,
                    client_memory_percent=sample.client_memory_percent,
                    client_disk_percent=sample.client_disk_percent,
                    server_cpu_percent=sample.server_cpu_percent,
                    server_memory_percent=sample.server_memory_percent,
                    server_disk_percent=sample.server_disk_percent,
                )

                if on_sample:
                    on_sample(sample)
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Upload interrupted.")
            return UploadResult(success=False, error="Upload interrupted")
        finally:
            stop_preview.set()
            self._terminate_process(srt_proc)
            self._terminate_process(ffmpeg_proc)

        return self._finalize_result(
            job,
            collector,
            zixi_enabled=zixi_poller.enabled,
            server_metrics_enabled=ingest_poller.enabled,
        )

    @staticmethod
    def _tail_file(path: str, max_lines: int = 5) -> str:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
        except OSError:
            return ""
        return "".join(lines[-max_lines:]).strip()

    @staticmethod
    def _drain_stream_to_file(stream, path: str) -> None:
        """Continuously drain a subprocess pipe to a file.

        Without this, an unread stderr PIPE can fill its OS buffer and block
        the publisher's write() calls indefinitely once verbose per-object
        logging accumulates, silently stalling media sends after subscribe.
        """
        try:
            with open(path, "wb") as fh:
                for chunk in iter(lambda: stream.read(4096), b""):
                    fh.write(chunk)
                    fh.flush()
        except (ValueError, OSError):
            pass

    def _run_moq_pipeline(
        self,
        job: UploadJob,
        on_sample: Optional[SampleCallback] = None,
    ) -> UploadResult:
        publisher_bin, publisher_backend = find_moq_publisher()
        if not publisher_bin:
            return UploadResult(
                success=False,
                error=(
                    "MoQ publisher not found. Install moq5 with ./scripts/install-moq5.sh "
                    "or openmoq with ./scripts/install-openmoq-publisher.sh."
                ),
            )

        target = job.destination.moq_target
        if target is None:
            return UploadResult(success=False, error="MOQ destination is missing publish settings.")

        temp_dir = tempfile.mkdtemp(prefix="moq-bench-")
        progress_path = os.path.join(temp_dir, "ffmpeg-progress.txt")
        qlog_dir = ""
        if publisher_backend == "moq5":
            qlog_dir = os.path.join(temp_dir, "qlog")
            os.makedirs(qlog_dir, exist_ok=True)

        ffmpeg_cmd = build_ffmpeg_moq_cmd(
            job.media_path,
            progress_path=progress_path,
            encode_ladder=job.encode_ladder,
            target_latency_ms=job.target_latency_ms,
            duration_sec=job.duration_sec,
        )
        publisher_cmd = build_moq_publisher_cmd(
            publisher_bin,
            publisher_backend,
            target,
            duration_sec=job.duration_sec,
            qlog_dir=qlog_dir,
            paced=not is_live_media_source(job.media_path),
        )
        logger.info(
            "MoQ publish via %s (%s) → %s namespace=%s forward=%s",
            publisher_backend,
            publisher_bin,
            target.endpoint,
            target.namespace,
            target.forward,
        )
        publisher_log_path = os.path.join(temp_dir, "publisher-stderr.log")
        print(
            f"MoQ publish via {publisher_backend}: namespace={target.namespace} "
            f"log={publisher_log_path} cmd={' '.join(publisher_cmd)}",
            flush=True,
        )

        ffmpeg_proc: Optional[subprocess.Popen] = None
        publisher_proc: Optional[subprocess.Popen] = None
        drain_thread: Optional[threading.Thread] = None
        fanout_thread: Optional[threading.Thread] = None
        tee_proc: Optional[subprocess.Popen] = None

        # Always tee MoQ fMP4 for Media Health (CMAF integrity); also used for encoder VMAF.
        job.encoder_capture_path = encoder_capture_path(temp_dir, "moq")

        try:
            ffmpeg_proc = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if ffmpeg_proc.stdout is not None:
                tee_proc = start_moq_capture_tee(
                    ffmpeg_proc.stdout,
                    job.encoder_capture_path,
                )
                ffmpeg_proc.stdout.close()
                publisher_proc = subprocess.Popen(
                    publisher_cmd,
                    stdin=tee_proc.stdout,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                if tee_proc.stdout is not None:
                    tee_proc.stdout.close()
            else:
                publisher_proc = subprocess.Popen(
                    publisher_cmd,
                    stdin=ffmpeg_proc.stdout,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                if ffmpeg_proc.stdout is not None:
                    ffmpeg_proc.stdout.close()
            # Drain continuously — an unread stderr PIPE can fill its OS
            # buffer and block the publisher's writes once it logs enough,
            # silently stalling media sends well after SUBSCRIBE succeeds.
            if publisher_proc.stderr is not None:
                drain_thread = threading.Thread(
                    target=self._drain_stream_to_file,
                    args=(publisher_proc.stderr, publisher_log_path),
                    daemon=True,
                )
                drain_thread.start()
        except FileNotFoundError:
            self._terminate_process(ffmpeg_proc)
            return UploadResult(success=False, error="ffmpeg not found in PATH")

        progress_reader = FfmpegProgressFileReader(progress_path)
        collector = MetricsCollector(
            protocol=job.destination.protocol,
            endpoint_url=job.destination.url,
            run_id=job.job_id,
        )
        # For MoQ, prefer GCP Monitoring on the relay VM (ingest agent is often
        # the shared Zixi/VMAF worker, not the relay itself).
        ingest_poller = IngestHostMetricsPoller(
            job.destination.url,
            agent_url=job.ingest_agent_url,
            ingest_provider=job.destination.ingest_provider or "gcp_moq_relay",
        )
        moqx_poller = MoqxStatsPoller(job.destination.url)
        qlog_tailer = PicoquicQlogTailer(qlog_dir) if qlog_dir else None
        # openmoq has no qlog; probe relay admin TCP for path RTT/jitter equivalent.
        path_rtt_probe = PathRttProbe(job.destination.url)
        start_time = time.time()
        prev_moqx_loss = 0
        prev_moqx_retrans = 0
        prev_moqx_sent = 0

        try:
            while time.time() - start_time < job.duration_sec:
                if job.is_cancelled():
                    logger.info("MoQ upload job %s cancelled by user", job.job_id)
                    break
                if ffmpeg_proc.poll() is not None:
                    if ffmpeg_proc.returncode == 0:
                        logger.info("ffmpeg finished cleanly before duration; finalizing MoQ job")
                        break
                    return UploadResult(
                        success=False,
                        error=self._ffmpeg_failure_message(ffmpeg_proc),
                    )
                if publisher_proc.poll() is not None:
                    if drain_thread is not None:
                        drain_thread.join(timeout=2)
                    detail = self._tail_file(publisher_log_path) or "unknown error"
                    code = publisher_proc.returncode
                    if code not in (0, None):
                        return UploadResult(
                            success=False,
                            error=f"{publisher_backend} publisher exited with code {code}: {detail}",
                        )
                    return UploadResult(
                        success=False,
                        error=f"{publisher_backend} publisher exited early ({detail})",
                    )

                status = progress_reader.get_status()
                client_host = read_client_host_metrics()
                server_host = ingest_poller.poll() if ingest_poller.enabled else None
                moqx_stats = moqx_poller.poll() if moqx_poller.enabled else None
                moqx_deltas = moqx_poller.job_window_deltas() if moqx_poller.enabled else None
                quic_stats = qlog_tailer.poll() if qlog_tailer and qlog_tailer.enabled else None
                path_rtt = path_rtt_probe.poll() if path_rtt_probe.enabled else None
                elapsed = int(time.time() - start_time)
                pids = [pid for pid in (ffmpeg_proc.pid, publisher_proc.pid if publisher_proc else None) if pid]
                cpu, mem = self._process_usage(pids)
                send_mbps = status.bitrate_kbps / 1000.0
                encoded_bitrate_kbps = status.bitrate_kbps or (send_mbps * 1000.0)
                encode_lag_ms = compute_encode_lag_ms(float(elapsed), status.out_time)

                # Prefer native QUIC smoothed RTT (moq5 qlog); else path TCP probe.
                quic_rtt = quic_stats.rtt_ms if quic_stats and quic_stats.rtt_ms > 0 else 0.0
                path_rtt_ms = path_rtt.rtt_ms if path_rtt else 0.0
                path_jitter_ms = path_rtt.jitter_ms if path_rtt else 0.0
                net_rtt = quic_rtt or path_rtt_ms
                net_jitter = path_jitter_ms if quic_rtt <= 0 else 0.0

                quic_packets_lost = quic_stats.packets_lost if quic_stats else 0
                quic_cwnd = quic_stats.cwnd_bytes if quic_stats else 0
                net_loss_pct = 0.0
                net_retrans_pct = 0.0
                if moqx_deltas is not None:
                    sent_delta = max(0, moqx_deltas.quic_packets_sent - prev_moqx_sent)
                    loss_delta = max(0, moqx_deltas.quic_packet_loss - prev_moqx_loss)
                    retrans_delta = max(
                        0, moqx_deltas.quic_packet_retransmissions - prev_moqx_retrans
                    )
                    prev_moqx_sent = moqx_deltas.quic_packets_sent
                    prev_moqx_loss = moqx_deltas.quic_packet_loss
                    prev_moqx_retrans = moqx_deltas.quic_packet_retransmissions
                    # Cumulative job-window loss for quic_packets_lost chart; rates from Δ.
                    quic_packets_lost = max(quic_packets_lost, moqx_deltas.quic_packet_loss)
                    denom = max(sent_delta, 1)
                    if sent_delta > 0:
                        net_loss_pct = min(100.0, (loss_delta / denom) * 100.0)
                        net_retrans_pct = min(100.0, (retrans_delta / denom) * 100.0)

                sample = UploadSample(
                    elapsed_sec=elapsed,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    fps_stability=0.0,
                    speed=status.speed,
                    out_time=status.out_time,
                    cpu_percent=cpu,
                    memory_mb=mem,
                    progress=status.progress,
                    transport_rtt_ms=net_rtt,
                    transport_rtt_jitter_ms=net_jitter,
                    encoder_send_rate_mbps=send_mbps,
                    net_rtt_ms=net_rtt,
                    net_jitter_ms=net_jitter,
                    net_send_mbps=send_mbps,
                    net_loss_pct=net_loss_pct,
                    net_retrans_pct=net_retrans_pct,
                    encode_lag_ms=encode_lag_ms,
                    client_memory_percent=client_host.memory_percent,
                    client_disk_percent=client_host.disk_percent,
                    server_cpu_percent=server_host.cpu_percent if server_host else 0.0,
                    server_memory_percent=server_host.memory_percent if server_host else 0.0,
                    server_disk_percent=server_host.disk_percent if server_host else 0.0,
                    moqx_subscribe_success=moqx_stats.subscribe_success if moqx_stats else 0,
                    moqx_subscribe_error=moqx_stats.subscribe_error if moqx_stats else 0,
                    moqx_publish_namespace_success=(
                        moqx_stats.publish_namespace_success if moqx_stats else 0
                    ),
                    moqx_publish_received=moqx_stats.publish_received if moqx_stats else 0,
                    moqx_publish_done=moqx_stats.publish_done if moqx_stats else 0,
                    quic_rtt_ms=net_rtt,
                    quic_cwnd_bytes=quic_cwnd,
                    quic_packets_lost=quic_packets_lost,
                )
                sample.fps_stability = collector.record_sample(
                    pid=ffmpeg_proc.pid,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                    extra_pids=[publisher_proc.pid] if publisher_proc else None,
                    transport_rtt_ms=net_rtt,
                    transport_rtt_jitter_ms=net_jitter,
                    encoder_send_rate_mbps=send_mbps,
                    encode_lag_ms=encode_lag_ms,
                    net_rtt_ms=net_rtt,
                    net_jitter_ms=net_jitter,
                    net_send_mbps=send_mbps,
                    net_loss_pct=net_loss_pct,
                    net_retrans_pct=net_retrans_pct,
                    client_memory_percent=sample.client_memory_percent,
                    client_disk_percent=sample.client_disk_percent,
                    server_cpu_percent=sample.server_cpu_percent,
                    server_memory_percent=sample.server_memory_percent,
                    server_disk_percent=sample.server_disk_percent,
                    moqx_subscribe_success=sample.moqx_subscribe_success,
                    moqx_subscribe_error=sample.moqx_subscribe_error,
                    moqx_publish_namespace_success=sample.moqx_publish_namespace_success,
                    moqx_publish_received=sample.moqx_publish_received,
                    moqx_publish_done=sample.moqx_publish_done,
                    quic_rtt_ms=sample.quic_rtt_ms,
                    quic_cwnd_bytes=sample.quic_cwnd_bytes,
                    quic_packets_lost=sample.quic_packets_lost,
                )

                if on_sample:
                    on_sample(sample)
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Upload interrupted.")
            return UploadResult(success=False, error="Upload interrupted")
        finally:
            self._terminate_process(publisher_proc)
            self._terminate_process(ffmpeg_proc)
            if tee_proc is not None:
                tee_proc.wait(timeout=5)
            if fanout_thread is not None:
                fanout_thread.join(timeout=5)
            if drain_thread is not None:
                drain_thread.join(timeout=2)
            tail = self._tail_file(publisher_log_path, max_lines=15)
            if tail:
                print(f"MoQ publisher log tail ({publisher_log_path}):\n{tail}", flush=True)

        return self._finalize_result(
            job,
            collector,
            server_metrics_enabled=ingest_poller.enabled,
            moqx_metrics_enabled=moqx_poller.enabled,
            quic_qlog_enabled=bool(qlog_tailer and qlog_tailer.enabled),
            quic_qlog_dir=qlog_dir,
        )

    def _finalize_result(
        self,
        job: UploadJob,
        collector: MetricsCollector,
        *,
        zixi_enabled: bool = False,
        server_metrics_enabled: bool = False,
        moqx_metrics_enabled: bool = False,
        quic_qlog_enabled: bool = False,
        quic_qlog_dir: str = "",
    ) -> UploadResult:
        vmaf_score = None
        psnr_db = None
        ssim = None
        encoder_vmaf_status = "disabled"
        encoder_vmaf_score = None
        encoder_psnr_db = None
        encoder_ssim = None
        encoder_vmaf_error = None
        quality_legs: dict = {}
        should_compute_legacy_local_vmaf = (
            not job.compute_vmaf_on_ingest
            and not job.compute_vmaf_encoder
            and (job.compute_vmaf or bool(os.environ.get("MOQ_COMPUTE_VMAF")))
        )
        distorted_path = job.distorted_path or os.environ.get("MOQ_VMAF_DISTORTED", "")

        if should_compute_legacy_local_vmaf and distorted_path:
            vmaf_result = compute_vmaf(job.media_path, distorted_path)
            if vmaf_result is not None:
                vmaf_score = vmaf_result.vmaf_score
                psnr_db = vmaf_result.psnr_db
                ssim = vmaf_result.ssim

        if job.compute_vmaf_encoder:
            capture_path = job.encoder_capture_path
            if capture_path and os.path.exists(capture_path) and os.path.getsize(capture_path) > 0:
                if job.on_encoder_vmaf_status:
                    try:
                        job.on_encoder_vmaf_status("computing")
                    except Exception:
                        logger.warning("on_encoder_vmaf_status callback failed", exc_info=True)
                encoder_result = compute_vmaf(job.media_path, capture_path)
                if encoder_result is not None:
                    quality_legs["encoder"] = quality_leg_from_vmaf_result(
                        encoder_result,
                        status="completed",
                        computed_on="local",
                        distorted_path=capture_path,
                    )
                    encoder_vmaf_status = "completed"
                    encoder_vmaf_score = encoder_result.vmaf_score
                    encoder_psnr_db = encoder_result.psnr_db
                    encoder_ssim = encoder_result.ssim
                else:
                    encoder_vmaf_error = "Encoder VMAF calculation failed"
                    quality_legs["encoder"] = quality_leg_from_vmaf_result(
                        None,
                        status="failed",
                        computed_on="local",
                        distorted_path=capture_path,
                        error=encoder_vmaf_error,
                    )
                    encoder_vmaf_status = "failed"
            else:
                encoder_vmaf_error = "Encoder capture file missing or empty"
                quality_legs["encoder"] = quality_leg_from_vmaf_result(
                    None,
                    status="failed",
                    computed_on="local",
                    distorted_path=capture_path,
                    error=encoder_vmaf_error,
                )
                encoder_vmaf_status = "failed"

        if job.compute_vmaf_on_ingest:
            quality_legs["ingest"] = {
                "status": "pending",
                "computed_on": "ingest_agent",
            }

        quality_payload = build_quality_payload(
            encoder=quality_legs.get("encoder"),
            ingest=quality_legs.get("ingest"),
        )

        srt_summary = collector.summarize_srt() if job.destination.protocol == "srt" else None
        summary_path = collector.write_summary(
            vmaf_score=vmaf_score,
            psnr_db=psnr_db,
            ssim=ssim,
            srt_summary=srt_summary,
            quality=quality_payload or None,
            extra={
                "comparison_id": job.comparison_id,
                "stream_index": job.stream_index,
                "stream_label": job.stream_label,
                **encode_profile_summary(job.encode_ladder, job.target_latency_ms),
                "vmaf_available": vmaf_score is not None,
                "vmaf_computed_on": "local" if vmaf_score is not None else "",
                "vmaf_pending_on_ingest": job.compute_vmaf_on_ingest,
                "vmaf_via": "ingest_agent" if job.compute_vmaf_on_ingest else "",
                "encoder_vmaf_requested": job.compute_vmaf_encoder,
                "encoder_capture_path": job.encoder_capture_path,
                "zixi_poller_enabled": zixi_enabled,
                "server_metrics_enabled": server_metrics_enabled,
                "moqx_metrics_enabled": moqx_metrics_enabled,
                "quic_qlog_enabled": quic_qlog_enabled,
                "quic_qlog_dir": quic_qlog_dir,
                "vmaf_note": (
                    "Ingest VMAF will be computed on the ingest host after the upload completes."
                    if job.compute_vmaf_on_ingest
                    else (
                        "VMAF requires a recorded output file (MOQ_VMAF_DISTORTED or job.distorted_path)."
                        if should_compute_legacy_local_vmaf and vmaf_score is None
                        else ""
                    )
                ),
            },
        )

        if job.destination.protocol == "moq":
            capture_path = job.encoder_capture_path
            if capture_path and os.path.exists(capture_path) and os.path.getsize(capture_path) > 0:
                try:
                    from media_health import analyze_media_health_file, patch_summary_with_media_health

                    report = analyze_media_health_file(capture_path)
                    patch_summary_with_media_health(
                        summary_path,
                        report,
                        computed_on="encoder_capture",
                    )
                except Exception as exc:
                    logger.warning("MoQ media health analysis failed: %s", exc)

        return UploadResult(
            success=True,
            csv_path=collector.filename,
            summary_path=summary_path,
            vmaf_score=vmaf_score,
            psnr_db=psnr_db,
            ssim=ssim,
            encoder_vmaf_status=encoder_vmaf_status,
            encoder_vmaf_score=encoder_vmaf_score,
            encoder_psnr_db=encoder_psnr_db,
            encoder_ssim=encoder_ssim,
            encoder_vmaf_error=encoder_vmaf_error,
        )

    def _ffmpeg_failure_message(self, process: subprocess.Popen) -> str:
        stderr = ""
        if process.stderr:
            stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
        detail = stderr.splitlines()[-1] if stderr else "unknown error"
        message = f"ffmpeg exited with code {process.returncode}: {detail}"
        if "Input/output error" in stderr and "rtmp://" in stderr.lower():
            message += (
                " Zixi RTMP push requires an ONLINE push input whose Stream ID matches "
                "the URL stream key (benchmark for rtmp://host:1935/live/benchmark). "
                "Re-run infra/zixi/scripts/configure-zixi-rtmp-input.sh on the ingest host."
            )
        if ("timed out" in stderr.lower() or "timeout" in stderr.lower()) and ":7777/" in stderr:
            message += (
                " Zixi's TS-over-HTTP push input stopped draining the PUT socket "
                "after the initial burst (reproduced independently of this service — "
                "raw ffmpeg PUT freezes identically after ~2s). This looks like a "
                "Zixi-side limitation with continuous chunked TS push, not an "
                "encoder/network issue here. Ask Zixi support to confirm HTTP TS "
                "push input support for sustained live streams; use SRT/RTMP "
                "ingest to Zixi for reliable DASH/HLS delivery in the meantime."
            )
        return message

    def _process_usage(self, pids: List[int]) -> tuple[float, float]:
        cpu_total = 0.0
        mem_total = 0.0
        for pid in pids:
            try:
                proc = psutil.Process(pid)
                cpu_total += proc.cpu_percent(interval=None)
                mem_total += proc.memory_info().rss / (1024 * 1024)
            except Exception:
                # Best-effort resource sampling: a sandboxed/restricted environment can
                # make psutil's underlying syscalls (e.g. sysctlbyname on macOS) raise
                # PermissionError/SystemError instead of a psutil.Error subclass. Never
                # let sampling failures kill the benchmark job thread.
                continue
        return cpu_total, mem_total

    def _terminate_process(self, process: Optional[subprocess.Popen]) -> None:
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
