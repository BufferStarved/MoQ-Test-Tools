import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import logging
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Dict, List, Optional
from urllib.parse import urlparse

import psutil

from destinations import DestinationProfile
from encode_profile import (
    ASSUMED_FPS,
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_TARGET_LATENCY_MS,
    build_video_encode_args,
    clamp_srt_target_latency_ms,
    clamp_target_latency_ms,
    effective_srt_caller_latency_ms,
    encode_profile_summary,
    with_srt_latency,
)
from endpoint_probe import probe_endpoint
from ingest_host_metrics import IngestHostMetricsPoller
from metrics import EncodeLagTracker, MetricsCollector
from moq_preview import (
    moq_job_should_fail_without_namespace,
    moq_publish_missing_error,
    should_mark_moq_preview_ready,
)
from moq_publish import (
    BROWSER_COMPAT_AUDIO_ARGS,
    WHIP_COMPAT_AUDIO_ARGS,
    PUBLISHER_WEBTRANSPORT_WAIT_SEC,
    publisher_webtransport_connected,
    should_pace_moq_publisher,
    wait_for_publisher_webtransport,
    MPEGTS_VIDEO_BSF,
    build_ffmpeg_input_args,
    build_ffmpeg_moq_cmd,
    build_moq_publisher_cmd,
    find_ffmpeg,
    ffmpeg_has_whip_muxer,
    find_moq_publisher,
    whip_ffmpeg_missing_error,
    is_device_webcam_source,
    is_live_media_source,
    mediamtx_loopback_publish_url,
    with_srt_stream_id,
    zixi_http_push_stream_id_for_preset,
    zixi_rtmp_stream_id_for_preset,
    zixi_srt_stream_id_for_preset,
)
from moqx_stats import MoqxStatsPoller
from path_rtt import PathRttProbe
from picoquic_qlog import PicoquicQlogTailer
from zixi_hls_health import (
    zixi_hls_heal_kind,
    mediamtx_hls_playback_url,
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
    fanout_stdout,
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


_MOQ_PREVIEW_GRACE_SEC_VOD = 8.0
_MOQ_PREVIEW_GRACE_SEC_LIVE_MIN = 8.0
_MOQ_PREVIEW_GRACE_SEC_LIVE_MAX = 30.0

# libx264 prints per-frame QP/NAL stats on SIGTERM teardown. That dump is
# normal encoder shutdown, not a codec crash — keep it out of UI errors.
_FFMPEG_TEARDOWN_NOISE = re.compile(
    r"^(?:frame=\s*\d+|x264 \[info\]: frame )",
    re.IGNORECASE,
)
_FFMPEG_SIGTERM_LOG = re.compile(
    r"received signal\s+(?:15|SIGTERM)\b|Exiting normally, received signal",
    re.IGNORECASE,
)


def ffmpeg_exit_is_sigterm(returncode: Optional[int], stderr: str = "") -> bool:
    """True when ffmpeg exited because it was sent SIGTERM (signal 15).

    Python reports a signaled child as ``-15``. ffmpeg itself often exits
    255 after catching SIGTERM and printing "Exiting normally, received
    signal 15". Bare 255 without that log is *not* treated as SIGTERM —
    ffmpeg uses 255 for many real muxer/encoder failures.
    """
    if returncode is None:
        return False
    if returncode < 0:
        return -returncode == signal.SIGTERM
    if returncode == 128 + signal.SIGTERM:
        return True
    return bool(_FFMPEG_SIGTERM_LOG.search(stderr or ""))


def ffmpeg_stderr_useful_detail(stderr: str, *, max_lines: int = 12) -> str:
    """Last useful ffmpeg log lines, without x264 frame-stat teardown dumps."""
    lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
    kept = [line for line in lines if not _FFMPEG_TEARDOWN_NOISE.match(line)]
    chosen = kept[-max_lines:] if kept else lines[-max_lines:]
    return " | ".join(chosen) if chosen else ""


def moq_preview_ready_grace_sec(media_path: str, duration_sec: float) -> float:
    """How long to wait for a *confirmed* relay namespace-publish success
    before falling back to an unconditional "preview ready" (see the
    MoQ pipeline loop for why lying here is dangerous — a premature "ready"
    signal makes the frontend start subscribing before openmoq-publisher has
    announced the namespace, guaranteeing a "no such namespace or track"
    refusal that eats the frontend's whole retry budget for nothing).

    A live browser-webcam source sits behind a much longer startup chain
    (browser MediaRecorder -> WS -> ffmpeg bridge -> UDP tee -> this
    per-destination ffmpeg -> openmoq-publisher) than a VOD file, whose
    ffmpeg starts reading immediately — so it gets a proportionally longer,
    but still bounded (capped, and never exceeding the job's own duration),
    grace period.
    """
    if not is_live_media_source(media_path):
        return _MOQ_PREVIEW_GRACE_SEC_VOD
    return min(
        _MOQ_PREVIEW_GRACE_SEC_LIVE_MAX,
        max(_MOQ_PREVIEW_GRACE_SEC_LIVE_MIN, duration_sec - 5.0),
    )


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
    # Live sources (webcam bridge UDP) have no file to score against. When
    # encoder VMAF is requested, the encode ffmpeg also stream-copies the
    # exact input it consumed to this path — reference and distorted then
    # share the same first decodable frame and frame cadence, so libvmaf
    # alignment is inherent, and every leg scores against the same
    # bridge-normalized capture.
    vmaf_reference_capture_path: str = ""
    compute_vmaf: bool = False
    # "cloud" = encode on the API host (default). "local" = dispatch to a
    # connected publisher agent (laptop) for true internet-acquisition tests.
    publisher_host: str = "cloud"
    cancel_event: Optional[threading.Event] = None
    # JobManager sets this so SRT preview stays gated until HLS segments are readable.
    on_preview_ready: Optional[Callable[[bool], None]] = field(default=None, repr=False)
    # Latency anchor: wall epoch stamped immediately before the leg encoder
    # spawns. With -re (VOD) / live capture, media time m is read at
    # media_zero_epoch + m, so glass-to-glass = display_wall − (anchor + m).
    # first_sample_at_epoch (ffmpeg's first *progress report*) lags the true
    # media zero by the encoder pipeline delay (~2s measured 2026-08-09) and
    # must not be used as the anchor.
    on_media_zero: Optional[Callable[[float], None]] = field(default=None, repr=False)
    # LL-HLS PDT transit: (first PROGRAM-DATE-TIME − (media_zero + segment
    # media time)) measured server-side; lets the player convert PDT-based
    # latency into encoder-anchored latency.
    on_packager_transit: Optional[Callable[[float], None]] = field(default=None, repr=False)
    # Zixi Fast HLS: encode-media time of buffer timeline 0 (hls.js maps the
    # playlist window at join to currentTime 0, not encode media 0). Published
    # once when the first segment is readable.
    on_delivery_media_origin: Optional[Callable[[float], None]] = field(
        default=None, repr=False
    )
    _media_zero_sent: bool = field(default=False, init=False, repr=False)
    _media_zero_epoch: Optional[float] = field(default=None, init=False, repr=False)
    _delivery_origin_sent: bool = field(default=False, init=False, repr=False)
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
        if self.destination.protocol == "srt":
            self.target_latency_ms = clamp_srt_target_latency_ms(self.target_latency_ms)
        self.encode_ladder = (self.encode_ladder or DEFAULT_ENCODE_LADDER_ID).strip().lower()
        if not self.ffmpeg_cmd:
            self.ffmpeg_cmd = self._build_ffmpeg_cmd()

    def refresh_ffmpeg_cmd(self) -> None:
        """Re-derive ``ffmpeg_cmd`` from the current ``media_path``.

        ``__post_init__`` bakes the command at construction time. Callers
        that rewrite ``media_path`` afterwards (the publisher agent swaps
        ``device:webcam`` for a brokered loopback ``udp://`` URL) must call
        this, or pipelines that reuse the frozen command (RTMP/WHIP direct,
        SRT direct) silently keep the original device-capture input and open
        the camera directly — the 2026-08-06 webcam-comparison incident.
        """
        self.ffmpeg_cmd = self._build_ffmpeg_cmd()

    def _video_args(self) -> List[str]:
        # MediaMTX is configured with hlsSegmentDuration=1s, but LL-HLS can
        # only cut segments on IDRs — a 2s GOP silently doubles the segment
        # (and therefore part/sync) granularity. Match the packager.
        # Live UDP/SRT inputs use -use_wallclock_as_timestamps; burn-in must
        # read PTS as unix time. File / device-webcam PTS is zero-based.
        wallclock_pts = is_live_media_source(self.media_path) and not is_device_webcam_source(
            self.media_path
        )
        vbv_stable = self.destination.protocol == "srt"
        if self._is_mediamtx_destination():
            return build_video_encode_args(
                self.encode_ladder,
                self.target_latency_ms,
                gop_frames=ASSUMED_FPS,  # 1s keyframe interval
                wallclock_pts=wallclock_pts,
                vbv_stability=vbv_stable,
            )
        return build_video_encode_args(
            self.encode_ladder,
            self.target_latency_ms,
            wallclock_pts=wallclock_pts,
            vbv_stability=vbv_stable,
        )

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
        # Live sources: stream-copy the consumed input as the VMAF reference
        # (see vmaf_reference_capture_path). Positioned as a second output so
        # the -c:v copy only applies to it, not the network encode. Device
        # webcams (local agent) are excluded — their input is raw video,
        # which cannot be stream-copied into MPEG-TS.
        reference_args: List[str] = []
        if (
            capture_path
            and is_live_media_source(self.media_path)
            and not is_device_webcam_source(self.media_path)
        ):
            self.vmaf_reference_capture_path = os.path.join(
                os.path.dirname(capture_path), "vmaf_reference.ts"
            )
            reference_args = [
                "-map",
                "0:v:0",
                "-c:v",
                "copy",
                "-f",
                "mpegts",
                self.vmaf_reference_capture_path,
            ]
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
            *reference_args,
        ]

    def _is_mediamtx_destination(self) -> bool:
        return _is_mediamtx_provider(self.destination.ingest_provider or "")

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
        """Zixi SRT/RTMP input stream ID for publish + HLS.

        Prefer an explicit job.zixi_stream_id when set (legacy per-job ids);
        otherwise the preset shared default ("SRT Test" / "benchmark").
        """
        if self.zixi_stream_id:
            return self.zixi_stream_id
        return zixi_srt_stream_id_for_preset(
            self.destination.preset_id
        ) or zixi_rtmp_stream_id_for_preset(self.destination.preset_id)

    def _resolved_srt_destination_url(self) -> str:
        url = self.destination.url
        stream_id = self.managed_zixi_stream_id()
        if stream_id:
            url = with_srt_stream_id(url, stream_id)
        latency_ms = effective_srt_caller_latency_ms(
            self.target_latency_ms,
            mediamtx=self._is_mediamtx_destination(),
        )
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
    cloud_provider: str = ""
    cloud_region: str = ""
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


def _sample_cloud_fields(destination: DestinationProfile) -> dict[str, str]:
    return {
        "cloud_provider": destination.cloud_provider or "",
        "cloud_region": destination.cloud_region or "",
    }


def _is_mediamtx_provider(ingest_provider: str) -> bool:
    return (ingest_provider or "").strip().lower().endswith("_mediamtx")


def _is_zixi_provider(ingest_provider: str) -> bool:
    return (ingest_provider or "").strip().lower().endswith("_zixi")


def _pick_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def sleep_until_next_tick(
    start_time: float,
    tick: int,
    *,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
    cancel_event: Optional[threading.Event] = None,
) -> int:
    """Sleep until ``start_time + tick`` seconds; return the next tick index.

    The sample loops used ``work + sleep(1)``, so ~0.2–0.3s of per-iteration
    probe work drifted the schedule and skipped one integer elapsed-second
    every ~5 iterations (RTMP recorded 24/30 samples, MoQ 25/30). Anchoring
    each iteration to ``start_time + n×1s`` samples every integer second. If
    an iteration overruns its slot, the missed seconds are skipped (never
    burst-sampled) and scheduling stays aligned to the original epoch.

    When *cancel_event* is set, return as soon as Stop is requested instead
    of sleeping out the rest of the tick (otherwise SIGTERM lands while we
    are still in this sleep and the next poll treats exit 255 as a crash).
    """
    deadline = start_time + tick
    remaining = deadline - now()
    if remaining > 0:
        if cancel_event is not None:
            cancel_event.wait(timeout=remaining)
        else:
            sleep(remaining)
        return tick + 1
    # Overran the slot: jump to the next whole-second tick still ahead.
    return max(tick + 1, int(now() - start_time) + 1)


class UploadService:
    # Zixi's SRT push input is a single shared listener (one port per input
    # object; see zixi_input_reset.py). Per-job stream IDs stop two runs from
    # reusing the same input object, but they still can't both bind that port
    # at once, so overlapping SRT jobs are serialized here instead of racing
    # add_stream/remove_stream calls against each other.
    _zixi_srt_ingest_lock = threading.Lock()

    def __init__(self) -> None:
        # psutil Process handles must persist across samples for cpu_percent
        # to measure anything (see _process_usage).
        self._proc_usage_cache: Dict[int, psutil.Process] = {}

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
                        # Stop while queued behind another SRT job is not an
                        # encode crash — finalize as success so the UI does
                        # not paint a red "ffmpeg 255" / ingest failure.
                        return UploadResult(success=True)
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
                ingest_provider=job.destination.ingest_provider or "",
            )
            if not ok:
                return UploadResult(success=False, error=probe_error)

        if job.destination.protocol == "webrtc":
            ffmpeg_bin = find_ffmpeg()
            if not ffmpeg_has_whip_muxer(ffmpeg_bin):
                return UploadResult(success=False, error=whip_ffmpeg_missing_error(ffmpeg_bin))

        process: Optional[subprocess.Popen] = None
        progress_reader: Optional[FfmpegProgressReader] = None
        temp_dir = ""
        ffmpeg_cmd = job.ffmpeg_cmd

        if job.compute_vmaf_encoder and job.destination.protocol != "webrtc":
            temp_dir = tempfile.mkdtemp(prefix="moq-bench-")
            job.encoder_capture_path = encoder_capture_path(
                temp_dir,
                job.destination.protocol,
            )
            ffmpeg_cmd = job._build_ffmpeg_cmd(capture_path=job.encoder_capture_path)
        elif job.compute_vmaf_encoder and job.destination.protocol == "webrtc":
            logger.warning(
                "Skipping encoder VMAF capture for WHIP job %s — ffmpeg cannot tee the WHIP muxer",
                job.job_id,
            )

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
            self._stamp_media_zero(job)
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
            cloud_provider=job.destination.cloud_provider or "",
            cloud_region=job.destination.cloud_region or "",
        )
        zixi_poller = self._zixi_poller_for_job(job, zixi_stats_url)
        mtx_poller = self._mediamtx_poller_for_job(job)
        ingest_poller = IngestHostMetricsPoller(
            job.destination.url,
            agent_url=job.ingest_agent_url,
            ingest_provider=job.destination.ingest_provider,
            publisher_host=job.publisher_host,
        )
        path_rtt_probe = self._path_rtt_probe_for_job(job)
        start_time = time.time()
        encode_lag_tracker = EncodeLagTracker()
        sample_tick = 1
        had_samples = False
        # Zixi tears down and recreates its RTMP push input between runs; a
        # push that lands during that window is rejected with an instant I/O
        # error (ffmpeg exit 251 within seconds — reproduced during gauntlet
        # runs 2026-07-22, and the likely cause of intermittent "RTMP never
        # started" runs). Back-to-back benchmarks make this race common.
        # Retry the connect a couple of times before declaring failure.
        _EARLY_EXIT_RETRY_WINDOW_SEC = 8.0
        _EARLY_EXIT_MAX_RETRIES = 2
        early_exit_retries = 0

        try:
            while time.time() - start_time < job.duration_sec:
                if job.is_cancelled():
                    logger.info("Upload job %s cancelled by user", job.job_id)
                    break
                if process.poll() is not None:
                    ran_sec = time.time() - start_time
                    outcome = self._ffmpeg_exit_outcome(
                        job,
                        process,
                        ran_sec=ran_sec,
                        preview_ready=had_samples,
                        had_samples=had_samples,
                        encode_speed=(
                            progress_reader.get_status().speed if progress_reader else 0.0
                        ),
                    )
                    if outcome is None:
                        # Clean EOF, user Stop, or SIGTERM after we asked to stop.
                        break
                    if (
                        job.destination.protocol == "rtmp"
                        and ran_sec < _EARLY_EXIT_RETRY_WINDOW_SEC
                        and early_exit_retries < _EARLY_EXIT_MAX_RETRIES
                        and not job.is_cancelled()
                        and "SIGTERM" not in (outcome.error or "")
                    ):
                        early_exit_retries += 1
                        logger.warning(
                            "RTMP publish for %s exited code %s after %.1fs — "
                            "retrying connect (%d/%d, Zixi input recreate race)",
                            job.job_id,
                            process.returncode,
                            ran_sec,
                            early_exit_retries,
                            _EARLY_EXIT_MAX_RETRIES,
                        )
                        time.sleep(2.0)
                        # Source restarts from media 0 — move the anchor too.
                        self._stamp_media_zero(job, restamp=True)
                        process = subprocess.Popen(
                            ffmpeg_cmd,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE,
                        )
                        progress_reader = FfmpegProgressReader(process.stdout)
                        start_time = time.time()
                        encode_lag_tracker = EncodeLagTracker()
                        sample_tick = 1
                        had_samples = False
                        continue
                    return outcome

                status = progress_reader.get_status()
                zixi_stats = zixi_poller.poll()
                mtx_stats = mtx_poller.poll() if mtx_poller else MediaMtxStatsSnapshot()
                path_rtt = path_rtt_probe.poll() if path_rtt_probe and path_rtt_probe.enabled else None
                client_host = read_client_host_metrics()
                server_host = ingest_poller.poll() if ingest_poller.enabled else None
                elapsed = int(time.time() - start_time)
                cpu, mem = self._process_usage([process.pid])
                send_mbps = status.bitrate_kbps / 1000.0
                encode_lag_ms = encode_lag_tracker.sample(float(elapsed), status.out_time)
                merged = self._merge_mediamtx_transport(
                    mtx=mtx_stats,
                    net_rtt_ms=zixi_stats.rtt_ms or (path_rtt.rtt_ms if path_rtt else 0.0),
                    net_jitter_ms=zixi_stats.jitter_ms or (path_rtt.jitter_ms if path_rtt else 0.0),
                    net_send_mbps=send_mbps,
                    net_recv_mbps=0.0,
                    net_loss_pct=zixi_stats.packet_loss_pct,
                    ts_continuity_counter_errors=zixi_stats.cc_errors,
                )
                encoded_bitrate_kbps = self._encoded_bitrate_kbps(
                    ffmpeg_kbps=status.bitrate_kbps,
                    merged_send_mbps=merged["net_send_mbps"],
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
                    **_sample_cloud_fields(job.destination),
                )
                sample.fps_stability = collector.record_sample(
                    pid=process.pid,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                    total_bytes_sent=status.total_bytes or None,
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
                had_samples = True
                sample_tick = sleep_until_next_tick(
                    start_time, sample_tick, cancel_event=job.cancel_event
                )
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

    def _stamp_media_zero(self, job: UploadJob, *, restamp: bool = False) -> None:
        """Record the wall epoch of media time zero (leg encoder spawn).

        Called immediately before the encoder process spawns. `restamp=True`
        is for retry paths that restart the source from media 0 (RTMP
        early-exit retry) — the anchor must move with the restart.
        """
        if job._media_zero_sent and not restamp:
            return
        job._media_zero_sent = True
        stamp = time.time()
        job._media_zero_epoch = stamp
        callback = job.on_media_zero
        if not callback:
            return
        try:
            callback(stamp)
        except Exception:
            logger.warning("on_media_zero callback failed", exc_info=True)

    def _notify_packager_transit(self, job: UploadJob, transit_ms: float) -> None:
        callback = job.on_packager_transit
        if not callback:
            return
        try:
            callback(float(transit_ms))
        except Exception:
            logger.warning("on_packager_transit callback failed", exc_info=True)

    def _notify_delivery_media_origin(self, job: UploadJob, origin_sec: float) -> None:
        callback = job.on_delivery_media_origin
        if not callback:
            return
        try:
            callback(float(origin_sec))
        except Exception:
            logger.warning("on_delivery_media_origin callback failed", exc_info=True)

    def _publish_zixi_delivery_media_origin(self, job: UploadJob) -> None:
        """Encode-media time of Fast HLS buffer time 0 at first segment ready.

        Zixi's 1-deep playlist keeps MEDIA-SEQUENCE at 0, so fragment-sn
        mapping cannot recover the join offset. At preview-ready the just-
        published segment of duration D ends near "now" on the encode
        timeline, so buffer time 0 ≈ (now − media_zero) − D.
        """
        if job._delivery_origin_sent:
            return
        anchor = job._media_zero_epoch
        if anchor is None:
            return
        manifest_url = self._managed_hls_manifest_url(job)
        if not manifest_url:
            return
        segment_dur = 2.0
        try:
            body = urllib.request.urlopen(manifest_url, timeout=2.0).read().decode(
                "utf-8", errors="replace"
            )
        except Exception:
            logger.debug("Zixi origin playlist probe failed", exc_info=True)
            return
        saw_segment = False
        for line in body.splitlines():
            if line.startswith("#EXTINF:"):
                try:
                    segment_dur = float(line.split(":", 1)[1].rstrip(",").split(",")[0])
                    saw_segment = True
                except ValueError:
                    pass
                break
        if not saw_segment:
            return
        # First HLS segment READY lags the encode read clock by the encoder
        # pipeline + Zixi packager spin-up (~1.2s measured 2026-08-10: raw
        # origin overstated join offset and understated RTMP e2e by the same).
        packager_spinup_sec = 1.25
        origin = max(0.0, time.time() - anchor - segment_dur - packager_spinup_sec)
        job._delivery_origin_sent = True
        logger.info(
            "Zixi delivery_media_origin for %s: %.2fs (segment=%.2fs spinup=%.2fs)",
            job.job_id,
            origin,
            segment_dur,
            packager_spinup_sec,
        )
        self._notify_delivery_media_origin(job, origin)

    def _is_mediamtx_destination(self, job: UploadJob) -> bool:
        return _is_mediamtx_provider(job.destination.ingest_provider or "")

    @staticmethod
    def _mediamtx_publish_host(job: UploadJob) -> str:
        return (urlparse(job.destination.url).hostname or "").strip()

    def _is_remote_mediamtx_publish(self, job: UploadJob) -> bool:
        """True when ffmpeg publishes to a MediaMTX that is not this host.

        Cloud encode on us-central1 targeting Linode / us-east1 must not use
        loopback HLS/metrics — those belong to the co-located central MediaMTX.
        The destination URL still carries the public IP even after loopback
        rewrite, so treat MEDIAMTX_PUBLIC_HOST (default moq-web-gcp) as local.
        """
        host = self._mediamtx_publish_host(job)
        if not host or host in {"127.0.0.1", "localhost", "::1"}:
            return False
        colocated = {
            item.strip()
            for item in os.environ.get("MEDIAMTX_PUBLIC_HOST", "34.9.217.178").split(",")
            if item.strip()
        }
        return host not in colocated

    def _mediamtx_poller_for_job(self, job: UploadJob) -> Optional[MediaMtxStatsPoller]:
        if not self._is_mediamtx_destination(job):
            return None
        agent_metrics = None
        agent_path = None
        if self._is_remote_mediamtx_publish(job):
            client = self._ingest_agent_client_for_job(job)
            if client is not None:
                path_name = MediaMtxStatsPoller._path_from_url(job.destination.url) or "benchmark"
                agent_metrics = client.mediamtx_metrics_text
                agent_path = lambda: client.mediamtx_path_text(path_name)
        return MediaMtxStatsPoller(
            endpoint_url=job.destination.url,
            agent_metrics=agent_metrics,
            agent_path=agent_path,
        )

    def _ingest_agent_client_for_job(self, job: UploadJob):
        from ingest_agent_client import IngestAgentClient, resolve_ingest_agent

        config = resolve_ingest_agent(
            job.destination.url,
            agent_url=job.ingest_agent_url,
            agent_token=job.ingest_agent_token,
        )
        if config is None:
            return None
        return IngestAgentClient(config)

    def _zixi_poller_for_job(self, job: UploadJob, stats_url: str) -> ZixiStatsPoller:
        if self._is_mediamtx_destination(job):
            return ZixiStatsPoller(stats_url, enabled=False)
        agent_fetch = None
        client = self._ingest_agent_client_for_job(job)
        if client is not None:
            agent_fetch = client.zixi_input_stats_text
        return ZixiStatsPoller(
            stats_url,
            input_id=(job.zixi_stream_id or "").strip() or None,
            agent_fetch=agent_fetch,
        )

    def _path_rtt_probe_for_job(self, job: UploadJob) -> Optional[PathRttProbe]:
        """TCP-connect RTT when the publish path has no native RTT gauge.

        Probe the ingest host's already-open TCP port (agent / HLS / HTTP-TS /
        RTMP / WHIP) instead of UDP SRT or a guessed :443 that may be closed.
        """
        protocol = (job.destination.protocol or "").strip().lower()
        dest_url = job.destination.url
        if protocol == "rtmp":
            parsed = urlparse(dest_url)
            return PathRttProbe(dest_url, port=parsed.port or 1935)
        if protocol == "webrtc":
            parsed = urlparse(dest_url)
            return PathRttProbe(dest_url, port=parsed.port or 8889)
        if protocol == "http":
            parsed = urlparse(dest_url)
            return PathRttProbe(dest_url, port=parsed.port or 7777)
        if protocol != "srt":
            return None
        url = job._resolved_srt_destination_url()
        if job.ingest_agent_url:
            parsed = urlparse(job.ingest_agent_url)
            return PathRttProbe(job.ingest_agent_url, port=parsed.port or 8090)
        if self._is_mediamtx_destination(job):
            return PathRttProbe(url, port=8888)
        return PathRttProbe(url, port=7777)

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

    @staticmethod
    def _encoded_bitrate_kbps(*, ffmpeg_kbps: float, merged_send_mbps: float) -> float:
        """Encoder bitrate for charts.

        ffmpeg -progress ``bitrate`` / ``total_size`` are N/A for the WHIP muxer
        (no file-like output), so fall back to merged send rate — typically
        MediaMTX ``paths_bytes_received`` / ``webrtc_sessions_bytes_received``.
        """
        if ffmpeg_kbps > 0:
            return ffmpeg_kbps
        if merged_send_mbps > 0:
            return merged_send_mbps * 1000.0
        return 0.0

    def _managed_hls_manifest_url(self, job: UploadJob) -> Optional[str]:
        if self._is_mediamtx_destination(job):
            if job.publisher_host == "local" or self._is_remote_mediamtx_publish(job):
                # Laptop agents and cross-cloud encodes are not co-located with
                # MediaMTX. Probe the same public LL-HLS origin the browser uses.
                # Loopback here would hit us-central1 MediaMTX (or nothing).
                return mediamtx_hls_playback_url("benchmark", endpoint_url=job.destination.url)
            # Cloud encode is co-located with MediaMTX; probe via loopback. Hairpinning
            # to the VM's own public IP can hang, so public playback URLs stay in the
            # SPA/proxy for that case.
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
        if not _is_zixi_provider(job.destination.ingest_provider or ""):
            return None
        if job.destination.protocol in {"hls", "dash"}:
            return zixi_http_push_stream_id_for_preset(job.destination.preset_id) or "benchmark"
        if job.destination.protocol in {"rtmp", "srt"}:
            # Prefer the playback stream (EC for SRT when available) so mpegts.js
            # and Fast HLS gate on the same media the browser will pull.
            stream_id = (job.zixi_playback_stream_id or job.managed_zixi_stream_id() or "").strip()
            return stream_id or None
        return None

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
            from zixi_stats import zixi_api_base_for_endpoint

            ok = reset_zixi_srt_input_with_retry(
                stream_id,
                port=port,
                attempts=2,
                srt_latency_ms=job.target_latency_ms,
                max_bitrate_kbps=encode_profile_summary(
                    job.encode_ladder, job.target_latency_ms
                )["maxrate_kbps"],
                base_url=zixi_api_base_for_endpoint(job.destination.url),
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
            from zixi_stats import zixi_api_base_for_endpoint

            remove_zixi_srt_input(
                stream_id,
                base_url=zixi_api_base_for_endpoint(job.destination.url),
            )
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
        Zixi RTMP/SRT → HTTP-TS first (mpegts.js default), else Fast HLS segment.
        TS-PUT → HTTP-TS when configured.
        """
        if self._is_mediamtx_destination(job):
            poller = MediaMtxStatsPoller(endpoint_url=job.destination.url)
            probe_url = self._managed_hls_manifest_url(job)
            remote = self._is_remote_mediamtx_publish(job)
            while not stop_event.is_set():
                if not remote:
                    snap = poller.poll()
                    if snap.ready or snap.net_recv_mbps > 0 or snap.bytes_received > 0:
                        self._notify_preview_ready(job, True)
                        return
                # Remote MTX: public LL-HLS. Co-located: loopback (avoids hairpin).
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
            notified = False
            origin_deadline = 0.0
            heals_used = 0
            bad_since: Optional[float] = None
            rolling_sig: Optional[tuple] = None
            rolling_since: Optional[float] = None
            while not stop_event.is_set():
                ts_ok = probe_http_ts_ready(
                    http_ts_id,
                    endpoint_url=job.destination.url,
                    timeout=2.5,
                ).ok
                manifest_url = self._managed_hls_manifest_url(job)
                hls = None
                if manifest_url:
                    try:
                        hls = probe_hls_segment_ready(manifest_url, timeout=2.0)
                    except Exception:
                        logger.debug("HLS preview probe failed", exc_info=True)
                if ts_ok and not notified:
                    self._notify_preview_ready(job, True)
                    notified = True
                    origin_deadline = time.time() + 20.0
                if (
                    notified
                    and job.managed_zixi_stream_id()
                    and not job._delivery_origin_sent
                    and time.time() < origin_deadline
                    and job._media_zero_epoch is not None
                ):
                    self._publish_zixi_delivery_media_origin(job)
                # Default SRT path is direct ffmpeg — it has no sample-loop heal.
                # Keep watching Fast HLS here and refresh the EC packager once
                # if the playlist freezes while HTTP-TS stays live.
                if (
                    notified
                    and job.destination.protocol == "srt"
                    and job.managed_zixi_stream_id()
                    and heals_used < _HLS_HEAL_ATTEMPTS
                ):
                    now = time.time()
                    health_ok = bool(hls is not None and hls.ok)
                    stale_rolling = False
                    stuck = False
                    if health_ok and hls is not None:
                        bad_since = None
                        sig = (hls.media_sequence, hls.segment_uri)
                        if sig != rolling_sig:
                            rolling_sig = sig
                            rolling_since = now
                        stale_rolling = (
                            rolling_since is not None
                            and (now - rolling_since)
                            >= _hls_stale_rolling_threshold_sec(job.target_latency_ms)
                            and hls.depth <= 1
                        )
                    elif notified:
                        if bad_since is None:
                            bad_since = now
                        stuck = (now - bad_since) >= _hls_stuck_threshold_sec(
                            job.target_latency_ms
                        )
                    kind = zixi_hls_heal_kind(
                        health_ok=health_ok,
                        stale_rolling=stale_rolling,
                        stuck=stuck,
                        uses_ec=self._zixi_uses_error_concealment_playback(job),
                    )
                    if kind == "ec_recreate":
                        if self._heal_zixi_ec_playback(job):
                            heals_used += 1
                            bad_since = None
                            rolling_sig = None
                            rolling_since = None
                stop_event.wait(0.5)
            return
        manifest_url = self._managed_hls_manifest_url(job)
        if not manifest_url:
            # No gated delivery path — allow UI immediately (e.g. custom endpoints).
            self._notify_preview_ready(job, True)
            return
        while not stop_event.is_set():
            if probe_hls_segment_ready(manifest_url).ok:
                self._notify_preview_ready(job, True)
                # Zixi Fast HLS: publish buffer-timeline → encode-media origin
                # so the player can correct hls.js's join-window mapping.
                if job.managed_zixi_stream_id():
                    self._publish_zixi_delivery_media_origin(job)
                return
            stop_event.wait(0.5)

    def _measure_llhls_packager_transit(
        self,
        job: UploadJob,
        stop_event: threading.Event,
    ) -> None:
        """Measure encoder→packager transit for MediaMTX LL-HLS legs.

        MediaMTX stamps EXT-X-PROGRAM-DATE-TIME at packaging time. A frame at
        encode media time m was read at media_zero_epoch + m, so:

            transit = PDT(m) − (media_zero_epoch + m)

        which folds in SRT tsbpd + network + remux. The browser adds this to
        PDT-based player latency.

        PDT applies to the *next* segment/part (HLS spec). We only accept a
        fresh muxer window (MEDIA-SEQUENCE == 0) whose media position at the
        PDT cannot exceed wall elapsed since media_zero — leftover segments
        from a prior publish otherwise invent multi-second media times in the
        first second of a new encode and produce nonsense negative transit
        (2026-08-10 truth run: −3697ms from a 7s playlist at T+3.3s).
        """
        index_url = self._managed_hls_manifest_url(job)
        if not index_url:
            return
        deadline = time.time() + 25.0
        while job._media_zero_epoch is None and time.time() < deadline:
            if stop_event.wait(0.2):
                return
        variant_url: Optional[str] = None
        pdt_re = re.compile(r"#EXT-X-PROGRAM-DATE-TIME:(\S+)")
        while not stop_event.is_set() and time.time() < deadline:
            try:
                if variant_url is None:
                    body = urllib.request.urlopen(index_url, timeout=2.0).read().decode(
                        "utf-8", errors="replace"
                    )
                    for line in body.splitlines():
                        line = line.strip()
                        if line and not line.startswith("#") and "audio" not in line.lower():
                            variant_url = urllib.parse.urljoin(index_url, line)
                            break
                    if variant_url is None:
                        stop_event.wait(0.5)
                        continue
                body = urllib.request.urlopen(variant_url, timeout=2.0).read().decode(
                    "utf-8", errors="replace"
                )
            except Exception:
                stop_event.wait(0.5)
                continue
            media_sequence = 0
            media_pos = 0.0
            pdt_value: Optional[str] = None
            pdt_media_pos: Optional[float] = None
            for line in body.splitlines():
                line = line.strip()
                if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
                    try:
                        media_sequence = int(line.split(":", 1)[1])
                    except ValueError:
                        pass
                elif line.startswith("#EXTINF:"):
                    try:
                        duration = float(line.split(":", 1)[1].rstrip(",").split(",")[0])
                    except ValueError:
                        continue
                    media_pos += duration
                else:
                    match = pdt_re.match(line)
                    if match and pdt_value is None:
                        # PDT timestamps the NEXT segment/part — media time at
                        # that point is the sum of completed EXTINF so far.
                        pdt_value = match.group(1)
                        pdt_media_pos = media_pos
            if pdt_value is None or pdt_media_pos is None:
                stop_event.wait(0.5)
                continue
            anchor = job._media_zero_epoch
            if anchor is None:
                return
            try:
                pdt_epoch = datetime.fromisoformat(pdt_value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                logger.warning("Unparseable LL-HLS PDT %r", pdt_value)
                stop_event.wait(0.5)
                continue
            elapsed = pdt_epoch - anchor
            now = time.time()
            # Prefer a fresh muxer (sequence 0) with a media position that
            # cannot exceed wall elapsed.
            if media_sequence == 0 and pdt_media_pos <= elapsed + 0.75:
                transit_ms = (pdt_epoch - (anchor + pdt_media_pos)) * 1000.0
                if 0.0 < transit_ms < 15000.0:
                    logger.info(
                        "LL-HLS packager transit for %s: %.0fms (pdt=%s seq=%s pos=%.1fs)",
                        job.job_id,
                        transit_ms,
                        pdt_value,
                        media_sequence,
                        pdt_media_pos,
                    )
                    self._notify_packager_transit(job, transit_ms)
                    return
            # Fallback: MediaMTX often continues MEDIA-SEQUENCE across
            # republishes, so sequence==0 never appears. The first live-edge
            # PDT after our encode starts (PDT wall-clock ≈ now, elapsed < 8s)
            # packages the head of THIS publish — treat its media time as ~0.
            # Truth run 2026-08-10: sequence==0 path timed out; this recovers
            # the ~2.3s encoder→packager leg SRT was missing.
            if (
                0.5 < elapsed < 8.0
                and abs(pdt_epoch - now) < 2.0
                and time.time() - anchor > 3.0
            ):
                # First live-edge PDT packages media ≈0.5–1s into the publish,
                # not media 0 — subtract that or transit overstates by ~1s
                # (truth run 2026-08-10: 3.3s published vs ~2.3s implied by glass).
                transit_ms = (elapsed - 1.0) * 1000.0
                if 500.0 < transit_ms < 15000.0:
                    logger.info(
                        "LL-HLS packager transit for %s: %.0fms "
                        "(live-edge fallback pdt=%s seq=%s)",
                        job.job_id,
                        transit_ms,
                        pdt_value,
                        media_sequence,
                    )
                    self._notify_packager_transit(job, transit_ms)
                    return
            stop_event.wait(0.5)
        logger.warning(
            "LL-HLS transit probe timed out for %s without a usable PDT window",
            job.job_id,
        )

    def _zixi_uses_error_concealment_playback(self, job: UploadJob) -> bool:
        """True when the browser pulls the EC derivative, not the raw SRT input."""
        playback_id = (job.zixi_playback_stream_id or "").strip()
        return bool(playback_id and " EC" in playback_id)

    def _heal_zixi_ec_playback(self, job: UploadJob) -> bool:
        """Recreate the EC stream so Fast HLS gets a fresh packager."""
        source_id = job.managed_zixi_stream_id()
        if not source_id:
            return False
        try:
            from zixi_error_concealment import recreate_error_concealed_stream
            from zixi_stats import zixi_api_base_for_endpoint

            logger.warning(
                "HLS playlist wedged for job %s — recreating error-concealed stream "
                "(SRT push stays up).",
                job.job_id,
            )
            return bool(
                recreate_error_concealed_stream(
                    source_id,
                    base_url=zixi_api_base_for_endpoint(job.destination.url),
                )
            )
        except Exception:
            logger.exception("Zixi EC recreate failed for job %s", job.job_id)
            return False

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
        # Default OFF: direct ffmpeg→SRT is more stable on Zixi (no UDP hop /
        # live-transmit reconnect churn). Opt in with SRT_USE_LIVE_TRANSMIT=1 for
        # libsrt pkt_* CSV stats.
        use_live_transmit = live_transmit_flag in {"1", "true", "yes"} and bool(srt_bin)
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
            if self._is_mediamtx_destination(job):
                threading.Thread(
                    target=self._measure_llhls_packager_transit,
                    args=(job, stop_preview),
                    daemon=True,
                    name=f"llhls-transit-{job.job_id[:8]}",
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
            self._stamp_media_zero(job)
            ffmpeg_proc = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            if self._is_mediamtx_destination(job):
                threading.Thread(
                    target=self._measure_llhls_packager_transit,
                    args=(job, stop_preview),
                    daemon=True,
                    name=f"llhls-transit-{job.job_id[:8]}",
                ).start()
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
            cloud_provider=job.destination.cloud_provider or "",
            cloud_region=job.destination.cloud_region or "",
        )
        # Zixi API lookups on MediaMTX streamids (publish:benchmark) hang and
        # stall the sample loop — only poll Zixi for managed Zixi SRT.
        zixi_poller = self._zixi_poller_for_job(job, resolved_srt_url)
        mtx_poller = self._mediamtx_poller_for_job(job)
        ingest_poller = IngestHostMetricsPoller(
            job.destination.url,
            agent_url=job.ingest_agent_url,
            ingest_provider=job.destination.ingest_provider,
            publisher_host=job.publisher_host,
        )
        path_rtt_probe = self._path_rtt_probe_for_job(job)
        start_time = time.time()
        encode_lag_tracker = EncodeLagTracker()
        sample_tick = 1
        manifest_url = self._managed_hls_manifest_url(job)
        had_samples = False
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
                    outcome = self._ffmpeg_exit_outcome(
                        job,
                        ffmpeg_proc,
                        ran_sec=time.time() - start_time,
                        preview_ready=preview_ready,
                        had_samples=had_samples,
                        encode_speed=progress_reader.get_status().speed,
                    )
                    if outcome is None:
                        logger.info("ffmpeg finished before duration; finalizing SRT job")
                        break
                    return outcome
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
                path_rtt = (
                    path_rtt_probe.poll() if path_rtt_probe and path_rtt_probe.enabled else None
                )
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
                    elif manifest_url:
                        # Local agents and cloud encodes whose MediaMTX admin
                        # API is not reachable from this VM (loopback on the
                        # MTX host) used to sit on preview_ready=false forever
                        # while the tile said "Waiting for readable HLS
                        # segments...". Probe the same origin the browser uses.
                        try:
                            if probe_hls_segment_ready(manifest_url, timeout=2.0).ok:
                                logger.info(
                                    "MediaMTX preview ready for job %s (HLS probe)",
                                    job.job_id,
                                )
                                self._notify_preview_ready(job, True)
                                preview_ready = True
                        except Exception:
                            logger.debug(
                                "MediaMTX HLS fallback probe failed for job %s",
                                job.job_id,
                                exc_info=True,
                            )

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
                    health_ok = bool(health is not None and health.ok)
                    stale_rolling = False
                    stuck = False
                    if health_ok and health is not None:
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
                            rolling_since is not None
                            and (now - rolling_since)
                            >= _hls_stale_rolling_threshold_sec(job.target_latency_ms)
                            and health.depth <= 1
                        )
                    else:
                        if bad_since is None:
                            bad_since = now
                        stuck = (now - bad_since) >= _hls_stuck_threshold_sec(
                            job.target_latency_ms
                        )
                    kind = zixi_hls_heal_kind(
                        health_ok=health_ok,
                        stale_rolling=stale_rolling,
                        stuck=stuck,
                        uses_ec=self._zixi_uses_error_concealment_playback(job),
                    )
                    if kind and heals_used < _HLS_HEAL_ATTEMPTS:
                        if kind == "ec_recreate":
                            self._heal_zixi_ec_playback(job)
                            heals_used += 1
                            bad_since = None
                            rolling_sig = None
                            rolling_since = None
                        else:
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
                encode_lag_ms = encode_lag_tracker.sample(float(elapsed), status.out_time)
                # Publisher libsrt first; MediaMTX fills receiver RTT/loss/recv rate (and Zixi if any).
                merged = self._merge_mediamtx_transport(
                    mtx=mtx_stats,
                    net_rtt_ms=srt_stats.rtt_ms
                    or zixi_stats.rtt_ms
                    or (path_rtt.rtt_ms if path_rtt else 0.0),
                    net_jitter_ms=srt_stats.rtt_jitter_ms
                    or zixi_stats.jitter_ms
                    or (path_rtt.jitter_ms if path_rtt else 0.0),
                    net_send_mbps=send_mbps,
                    net_recv_mbps=srt_stats.mbps_recv_rate,
                    net_loss_pct=zixi_stats.packet_loss_pct,
                    pkt_rcv_drop=srt_stats.pkt_rcv_drop,
                    pkt_snd_drop=srt_stats.pkt_snd_drop,
                    pkt_snd_loss=srt_stats.pkt_snd_loss,
                    pkt_retrans=srt_stats.pkt_retrans,
                    ts_continuity_counter_errors=zixi_stats.cc_errors,
                )
                # ffmpeg -progress often reports bitrate=N/A for mpegts/UDP tee; use
                # libsrt send rate, then MediaMTX ingest receive rate.
                encoded_bitrate_kbps = self._encoded_bitrate_kbps(
                    ffmpeg_kbps=status.bitrate_kbps,
                    merged_send_mbps=merged["net_send_mbps"],
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
                    **_sample_cloud_fields(job.destination),
                )
                sample.fps_stability = collector.record_sample(
                    pid=ffmpeg_proc.pid,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                    total_bytes_sent=status.total_bytes or None,
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
                had_samples = True
                sample_tick = sleep_until_next_tick(
                    start_time, sample_tick, cancel_event=job.cancel_event
                )
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

        if (
            job.compute_vmaf_encoder
            and is_live_media_source(job.media_path)
            and not is_device_webcam_source(job.media_path)
        ):
            job.vmaf_reference_capture_path = os.path.join(temp_dir, "vmaf_reference.ts")
        ffmpeg_cmd = build_ffmpeg_moq_cmd(
            job.media_path,
            progress_path=progress_path,
            encode_ladder=job.encode_ladder,
            target_latency_ms=job.target_latency_ms,
            duration_sec=job.duration_sec,
            vmaf_reference_path=job.vmaf_reference_capture_path,
        )
        publisher_cmd = build_moq_publisher_cmd(
            publisher_bin,
            publisher_backend,
            target,
            duration_sec=job.duration_sec,
            qlog_dir=qlog_dir,
            paced=should_pace_moq_publisher(job.media_path),
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
        publisher_stdout_path = os.path.join(temp_dir, "publisher-stdout.log")
        ffmpeg_log_path = os.path.join(temp_dir, "ffmpeg-stderr.log")
        print(
            f"MoQ publish via {publisher_backend}: namespace={target.namespace} "
            f"log={publisher_log_path} ffmpeg_log={ffmpeg_log_path} cmd={' '.join(publisher_cmd)}",
            flush=True,
        )

        ffmpeg_proc: Optional[subprocess.Popen] = None
        publisher_proc: Optional[subprocess.Popen] = None
        drain_thread: Optional[threading.Thread] = None
        stdout_drain_thread: Optional[threading.Thread] = None
        ffmpeg_drain_thread: Optional[threading.Thread] = None
        fanout_thread: Optional[threading.Thread] = None
        tee_proc: Optional[subprocess.Popen] = None

        # Always tee MoQ fMP4 for Media Health (CMAF integrity); also used for encoder VMAF.
        job.encoder_capture_path = encoder_capture_path(temp_dir, "moq")

        try:
            self._stamp_media_zero(job)
            # Publisher first: the Linux binary is Docker-wrapped, so Popen
            # pays container startup before WebTransport CONNECT. Starting
            # ffmpeg first (bench-733f1d7c) let encode finish 240 CMAF
            # fragments while the relay never saw PUBLISH_NAMESPACE.
            publisher_proc = subprocess.Popen(
                publisher_cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if publisher_proc.stdout is not None:
                stdout_drain_thread = threading.Thread(
                    target=self._drain_stream_to_file,
                    args=(publisher_proc.stdout, publisher_stdout_path),
                    daemon=True,
                )
                stdout_drain_thread.start()
            if publisher_proc.stderr is not None:
                drain_thread = threading.Thread(
                    target=self._drain_stream_to_file,
                    args=(publisher_proc.stderr, publisher_log_path),
                    daemon=True,
                )
                drain_thread.start()
            connected = wait_for_publisher_webtransport(
                lambda: (
                    f"{self._tail_file(publisher_stdout_path, max_lines=50)}\n"
                    f"{self._tail_file(publisher_log_path, max_lines=50)}"
                ),
                lambda: publisher_proc.poll() is None,
            )
            if not connected:
                if drain_thread is not None:
                    drain_thread.join(timeout=2)
                if stdout_drain_thread is not None:
                    stdout_drain_thread.join(timeout=2)
                self._terminate_process(publisher_proc)
                detail = self._tail_file(publisher_log_path) or "unknown error"
                stdout_detail = self._tail_file(publisher_stdout_path, max_lines=10)
                if stdout_detail:
                    detail = f"{detail}\n{stdout_detail}"
                code = publisher_proc.returncode
                if code not in (0, None):
                    return UploadResult(
                        success=False,
                        error=(
                            f"{publisher_backend} publisher exited with code {code} "
                            f"before WebTransport CONNECT: {detail}"
                        ),
                    )
                return UploadResult(
                    success=False,
                    error=(
                        f"{publisher_backend} publisher never printed connection_id "
                        f"within {PUBLISHER_WEBTRANSPORT_WAIT_SEC:.0f}s "
                        f"(WebTransport CONNECT failed). {detail}"
                    ),
                )
            ffmpeg_proc = subprocess.Popen(
                ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if ffmpeg_proc.stdout is not None and publisher_proc.stdin is not None:
                tee_proc = start_moq_capture_tee(
                    ffmpeg_proc.stdout,
                    job.encoder_capture_path,
                )
                ffmpeg_proc.stdout.close()
                if tee_proc.stdout is not None:
                    fanout_thread = threading.Thread(
                        target=fanout_stdout,
                        args=(tee_proc.stdout, [publisher_proc.stdin]),
                        daemon=True,
                    )
                    fanout_thread.start()
            # Same risk applies to ffmpeg's own stderr: default -loglevel is
            # verbose, and a live UDP source with wallclock PTS regeneration
            # can log "Non-monotonic DTS"/timestamp-discontinuity warnings
            # fast enough to fill the pipe before a single frame is muxed —
            # blocking ffmpeg's own logging (and therefore encoding) with
            # nothing to show for it (0-byte capture, 0-byte progress file).
            # Drain to a file so this is diagnosable instead of silently lost.
            if ffmpeg_proc.stderr is not None:
                ffmpeg_drain_thread = threading.Thread(
                    target=self._drain_stream_to_file,
                    args=(ffmpeg_proc.stderr, ffmpeg_log_path),
                    daemon=True,
                )
                ffmpeg_drain_thread.start()
        except FileNotFoundError:
            self._terminate_process(publisher_proc)
            self._terminate_process(ffmpeg_proc)
            return UploadResult(success=False, error="ffmpeg not found in PATH")

        progress_reader = FfmpegProgressFileReader(progress_path)
        collector = MetricsCollector(
            protocol=job.destination.protocol,
            endpoint_url=job.destination.url,
            run_id=job.job_id,
            cloud_provider=job.destination.cloud_provider or "",
            cloud_region=job.destination.cloud_region or "",
        )
        # For MoQ, prefer GCP Monitoring on the relay VM (ingest agent is often
        # the shared Zixi/VMAF worker, not the relay itself).
        ingest_poller = IngestHostMetricsPoller(
            job.destination.url,
            agent_url=job.ingest_agent_url,
            ingest_provider=job.destination.ingest_provider or "gcp_moq_relay",
            publisher_host=job.publisher_host,
        )
        moqx_poller = MoqxStatsPoller(job.destination.url)
        qlog_tailer = PicoquicQlogTailer(qlog_dir) if qlog_dir else None
        # openmoq has no qlog; probe relay admin TCP for path RTT/jitter equivalent.
        path_rtt_probe = PathRttProbe(job.destination.url)
        start_time = time.time()
        encode_lag_tracker = EncodeLagTracker()
        sample_tick = 1
        prev_moqx_loss = 0
        prev_moqx_retrans = 0
        prev_moqx_sent = 0

        # Establish the moqx relay counter baseline now, before this job's
        # publisher has had any chance to register its namespace — see
        # job_manager.py's needs_publish_preview for why this matters (MoQ
        # has no reliable playback-rate catch-up, so a slow "is it live yet"
        # signal here becomes a permanent latency floor for the viewer).
        if moqx_poller.enabled:
            moqx_poller.poll()
        had_samples = False
        preview_ready_notified = False
        # If moqx metrics are unreachable/disabled, or the relay never shows a
        # namespace-publish success within this window, don't strand the
        # player on "waiting" forever — fall back to the old immediate-live
        # behavior after a bounded grace period. See moq_preview_ready_grace_sec
        # for why live webcam sources need much more of it than VOD files
        # (confirmed via QA harness: the old fixed 8s fired *before* the relay
        # had confirmed the namespace, producing the exact "no such namespace
        # or track" refusal + wasted retry budget this gate exists to avoid).
        preview_ready_deadline = start_time + moq_preview_ready_grace_sec(
            job.media_path, job.duration_sec
        )

        try:
            while time.time() - start_time < job.duration_sec:
                if job.is_cancelled():
                    logger.info("MoQ upload job %s cancelled by user", job.job_id)
                    break
                if ffmpeg_proc.poll() is not None:
                    if ffmpeg_drain_thread is not None:
                        ffmpeg_drain_thread.join(timeout=2)
                    outcome = self._ffmpeg_exit_outcome(
                        job,
                        ffmpeg_proc,
                        log_path=ffmpeg_log_path,
                        ran_sec=time.time() - start_time,
                        preview_ready=preview_ready_notified,
                        had_samples=had_samples,
                        encode_speed=progress_reader.get_status().speed,
                    )
                    if outcome is None:
                        logger.info("ffmpeg finished before duration; finalizing MoQ job")
                        break
                    return outcome
                if publisher_proc.poll() is not None:
                    if drain_thread is not None:
                        drain_thread.join(timeout=2)
                    if stdout_drain_thread is not None:
                        stdout_drain_thread.join(timeout=2)
                    if job.is_cancelled():
                        break
                    detail = self._tail_file(publisher_log_path) or "unknown error"
                    stdout_detail = self._tail_file(publisher_stdout_path, max_lines=10)
                    if stdout_detail:
                        detail = f"{detail}\n{stdout_detail}"
                    code = publisher_proc.returncode
                    ffmpeg_tail = ""
                    if ffmpeg_drain_thread is not None:
                        ffmpeg_drain_thread.join(timeout=1)
                    ffmpeg_tail = self._tail_file(ffmpeg_log_path, max_lines=15)
                    # Publisher stdin EOF after we already stopped ffmpeg
                    # (duration, user Stop, or SIGTERM teardown) is graceful
                    # EOS — not "publisher crashed".
                    ffmpeg_code = ffmpeg_proc.poll()
                    if (
                        code in (0, None)
                        and ffmpeg_code is not None
                        and (
                            ffmpeg_code == 0
                            or ffmpeg_exit_is_sigterm(ffmpeg_code, ffmpeg_tail)
                        )
                    ):
                        logger.info(
                            "MoQ publisher reached EOF after ffmpeg stop; finalizing job"
                        )
                        break
                    # "stdin EOF before ftyp box" means the publisher never saw a
                    # usable fMP4 header — ffmpeg upstream never muxed a frame.
                    if "ftyp" in detail.lower() or "eof" in detail.lower():
                        if ffmpeg_tail:
                            detail += f"\nffmpeg log tail ({ffmpeg_log_path}):\n{ffmpeg_tail}"
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
                if not preview_ready_notified:
                    publish_confirmed = (
                        moqx_poller.enabled and moqx_poller.publish_namespace_success_delta() >= 1
                    )
                    if should_mark_moq_preview_ready(
                        publish_confirmed=publish_confirmed,
                        poller_enabled=moqx_poller.observing,
                        past_deadline=time.time() >= preview_ready_deadline,
                    ):
                        preview_ready_notified = True
                        self._notify_preview_ready(job, True)
                quic_stats = qlog_tailer.poll() if qlog_tailer and qlog_tailer.enabled else None
                path_rtt = path_rtt_probe.poll() if path_rtt_probe.enabled else None
                elapsed = int(time.time() - start_time)
                pids = [pid for pid in (ffmpeg_proc.pid, publisher_proc.pid if publisher_proc else None) if pid]
                cpu, mem = self._process_usage(pids)
                send_mbps = status.bitrate_kbps / 1000.0
                encoded_bitrate_kbps = status.bitrate_kbps or (send_mbps * 1000.0)
                encode_lag_ms = encode_lag_tracker.sample(float(elapsed), status.out_time)

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
                    moqx_subscribe_success=moqx_deltas.subscribe_success if moqx_deltas else 0,
                    moqx_subscribe_error=moqx_deltas.subscribe_error if moqx_deltas else 0,
                    moqx_publish_namespace_success=(
                        moqx_deltas.publish_namespace_success if moqx_deltas else 0
                    ),
                    moqx_publish_received=moqx_stats.publish_received if moqx_stats else 0,
                    moqx_publish_done=moqx_stats.publish_done if moqx_stats else 0,
                    # Real QUIC smoothed RTT only (moq5 qlog). The TCP-probe
                    # fallback is NOT QUIC — it stays in net_rtt_ms where it is
                    # labeled as a path probe, instead of masquerading here.
                    quic_rtt_ms=quic_rtt,
                    quic_cwnd_bytes=quic_cwnd,
                    quic_packets_lost=quic_packets_lost,
                    **_sample_cloud_fields(job.destination),
                )
                sample.fps_stability = collector.record_sample(
                    pid=ffmpeg_proc.pid,
                    encoded_bitrate_kbps=encoded_bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                    total_bytes_sent=status.total_bytes or None,
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
                had_samples = True
                sample_tick = sleep_until_next_tick(
                    start_time, sample_tick, cancel_event=job.cancel_event
                )
        except KeyboardInterrupt:
            logger.info("Upload interrupted.")
            return UploadResult(success=False, error="Upload interrupted")
        finally:
            self._terminate_process(publisher_proc)
            self._terminate_process(ffmpeg_proc)
            if tee_proc is not None:
                # tee can survive its neighbors (blocked write into the dead
                # publisher's pipe). An uncaught TimeoutExpired here killed the
                # whole job thread — the job stayed "running" forever and the
                # player surfaced post-stop RESET_STREAM/starvation fatals
                # (observed live 2026-07-22 01:05).
                try:
                    tee_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    tee_proc.kill()
                    try:
                        tee_proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        logger.warning("MoQ capture tee did not exit after kill")
            if fanout_thread is not None:
                fanout_thread.join(timeout=5)
            if drain_thread is not None:
                drain_thread.join(timeout=2)
            if stdout_drain_thread is not None:
                stdout_drain_thread.join(timeout=2)
            if ffmpeg_drain_thread is not None:
                ffmpeg_drain_thread.join(timeout=2)
            tail = self._tail_file(publisher_log_path, max_lines=15)
            if tail:
                print(f"MoQ publisher log tail ({publisher_log_path}):\n{tail}", flush=True)
            stdout_tail = self._tail_file(publisher_stdout_path, max_lines=10)
            if stdout_tail:
                print(f"MoQ publisher stdout ({publisher_stdout_path}):\n{stdout_tail}", flush=True)
            ffmpeg_tail = self._tail_file(ffmpeg_log_path, max_lines=15)
            if ffmpeg_tail:
                print(f"MoQ ffmpeg log tail ({ffmpeg_log_path}):\n{ffmpeg_tail}", flush=True)

        publish_confirmed = (
            moqx_poller.observing and moqx_poller.publish_namespace_success_delta() >= 1
        )
        if moq_job_should_fail_without_namespace(
            publish_confirmed=publish_confirmed,
            poller_observing=moqx_poller.observing,
        ):
            namespace = ""
            if job.destination.moq_target is not None:
                namespace = job.destination.moq_target.namespace or ""
            finalized = self._finalize_result(
                job,
                collector,
                server_metrics_enabled=ingest_poller.enabled,
                moqx_metrics_enabled=moqx_poller.enabled,
                quic_qlog_enabled=bool(qlog_tailer and qlog_tailer.enabled),
                quic_qlog_dir=qlog_dir,
            )
            finalized.success = False
            finalized.error = moq_publish_missing_error(
                namespace=namespace,
                observing=True,
            )
            wt_log = (
                f"{self._tail_file(publisher_stdout_path, max_lines=20)}\n"
                f"{self._tail_file(publisher_log_path, max_lines=20)}"
            )
            if not publisher_webtransport_connected(wt_log):
                finalized.error += (
                    " WebTransport session never connected (no connection_id)."
                )
            return finalized

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
            # Live sources score against the per-job stream-copied input
            # capture (same frames the encoder consumed), not the media_path
            # (a udp:// URL that no longer exists once the job ends).
            reference_path = job.media_path
            if is_live_media_source(job.media_path):
                reference_path = job.vmaf_reference_capture_path
            reference_ok = bool(
                reference_path
                and os.path.exists(reference_path)
                and os.path.getsize(reference_path) > 0
            )
            if not reference_ok:
                encoder_vmaf_error = (
                    "VMAF reference capture missing or empty for live source"
                    if is_live_media_source(job.media_path)
                    else "VMAF reference media file missing or empty"
                )
                quality_legs["encoder"] = quality_leg_from_vmaf_result(
                    None,
                    status="failed",
                    computed_on="local",
                    distorted_path=capture_path,
                    error=encoder_vmaf_error,
                )
                encoder_vmaf_status = "failed"
            elif capture_path and os.path.exists(capture_path) and os.path.getsize(capture_path) > 0:
                if job.on_encoder_vmaf_status:
                    try:
                        job.on_encoder_vmaf_status("computing")
                    except Exception:
                        logger.warning("on_encoder_vmaf_status callback failed", exc_info=True)
                encoder_result = compute_vmaf(reference_path, capture_path)
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
                # encode_profile_summary reports the profile's uncapped SRT
                # latency; record what the caller actually used (MediaMTX caps
                # the caller latency at MEDIAMTX_SRT_MAX_CALLER_LATENCY_MS).
                **(
                    {
                        "srt_latency_us": effective_srt_caller_latency_ms(
                            job.target_latency_ms,
                            mediamtx=self._is_mediamtx_destination(job),
                        )
                        * 1000,
                        "srt_latency_us_profile": encode_profile_summary(
                            job.encode_ladder, job.target_latency_ms
                        )["srt_latency_us"],
                    }
                    if job.destination.protocol == "srt"
                    else {}
                ),
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

    def _ffmpeg_stderr_text(self, process: subprocess.Popen, log_path: str = "") -> str:
        stderr = ""
        if process.stderr:
            # If a drain thread already owns this pipe (see _run_moq_pipeline),
            # this read() races it and typically returns nothing — fall back
            # to the file the drain thread is writing to.
            stderr = process.stderr.read().decode("utf-8", errors="replace").strip()
        if not stderr and log_path:
            stderr = self._tail_file(log_path, max_lines=40)
        return stderr

    def _ffmpeg_exit_outcome(
        self,
        job: UploadJob,
        process: subprocess.Popen,
        *,
        log_path: str = "",
        ran_sec: float = 0.0,
        preview_ready: bool = True,
        had_samples: bool = True,
        encode_speed: float = 0.0,
    ) -> Optional[UploadResult]:
        """Classify a dead ffmpeg. None = finalize as success (not a crash).

        User Stop, wall-clock duration teardown, and SIGTERM after we asked
        the process to stop must not become a red ``ffmpeg exited with code
        255`` encode crash. Unexpected SIGTERM (we did not cancel) is still
        a failure, but the message says so explicitly — no x264 dump.
        """
        if process.returncode == 0:
            return None
        if job.is_cancelled():
            return None
        stderr = self._ffmpeg_stderr_text(process, log_path)
        if ffmpeg_exit_is_sigterm(process.returncode, stderr):
            # Duration-end and Stop both SIGTERM from ``finally``. If the
            # sample loop notices the death before ``is_cancelled()`` (or
            # before the while-duration check), we still treat requested
            # teardown as success. An unexpected kill while the job should
            # still be running is the remaining failure case.
            if ran_sec >= max(1.0, float(job.duration_sec) - 1.5):
                return None
            return UploadResult(
                success=False,
                error=self._unexpected_sigterm_message(
                    job,
                    ran_sec=ran_sec,
                    preview_ready=preview_ready,
                    had_samples=had_samples,
                    encode_speed=encode_speed,
                ),
            )
        return UploadResult(
            success=False,
            error=self._ffmpeg_failure_message(process, log_path, stderr=stderr),
        )

    def _unexpected_sigterm_message(
        self,
        job: UploadJob,
        *,
        ran_sec: float,
        preview_ready: bool,
        had_samples: bool,
        encode_speed: float,
    ) -> str:
        protocol = (job.destination.protocol or "").lower()
        parts = [
            f"ffmpeg was terminated (SIGTERM) after {ran_sec:.1f}s while the "
            f"{protocol or 'encode'} job was still running. This is a process "
            "kill, not a codec crash."
        ]
        if 0 < encode_speed < 0.9:
            parts.append(
                f" Encode was at {encode_speed:.2f}x realtime; there is no "
                "watchdog that kills a slow encode."
            )
        if not preview_ready or not had_samples:
            if protocol in {"rtmp", "srt", "hls", "dash"}:
                parts.append(
                    " Ingest never produced a playable preview — RTMP/SRT "
                    "wait for a readable segment after the encoder starts, "
                    "and SRT may still have been queued on the shared Zixi "
                    "input lock."
                )
            else:
                parts.append(" The encoder died before the first sample or preview.")
        return "".join(parts)

    def _ffmpeg_failure_message(
        self,
        process: subprocess.Popen,
        log_path: str = "",
        *,
        stderr: str = "",
    ) -> str:
        if not stderr:
            stderr = self._ffmpeg_stderr_text(process, log_path)
        if ffmpeg_exit_is_sigterm(process.returncode, stderr):
            return (
                f"ffmpeg was terminated (SIGTERM, exit {process.returncode}). "
                "This is a process kill, not a codec crash."
            )
        detail = ffmpeg_stderr_useful_detail(stderr) or "unknown error"
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
                # cpu_percent(interval=None) measures CPU since the previous
                # call on the SAME Process object — a fresh handle per sample
                # always returned 0.0. Cache handles per pid; psutil identity
                # checks (create_time) make stale reused-pid handles raise,
                # which evicts them below.
                proc = self._proc_usage_cache.get(pid)
                if proc is None:
                    proc = psutil.Process(pid)
                    self._proc_usage_cache[pid] = proc
                    proc.cpu_percent(interval=None)  # prime the CPU window
                cpu_total += proc.cpu_percent(interval=None)
                mem_total += proc.memory_info().rss / (1024 * 1024)
            except Exception:
                # Best-effort resource sampling: a sandboxed/restricted environment can
                # make psutil's underlying syscalls (e.g. sysctlbyname on macOS) raise
                # PermissionError/SystemError instead of a psutil.Error subclass. Never
                # let sampling failures kill the benchmark job thread.
                self._proc_usage_cache.pop(pid, None)
                continue
        return cpu_total, mem_total

    def _terminate_process(self, process: Optional[subprocess.Popen]) -> None:
        # NOTE: this body was previously (mis-)indented under the None guard,
        # so no benchmark subprocess was ever terminated — encoders kept
        # running past job end (verified live: encoder ran 5s+ after the job).
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                logger.warning("Process %s did not exit after kill", process.pid)
