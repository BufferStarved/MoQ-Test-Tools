import csv
import json
import logging
import os
import time
from typing import Callable, Dict, List, Optional

import psutil

from latency_budget import (
    E2E_SCOPE_CAPTURE_TO_GLASS,
    build_frame_row,
    build_latency_budget,
)
from srt_stats import SrtStatsSummary, summarize_srt_rows
from stats_window import RollingWindow

logger = logging.getLogger("MoQ-SRT-Bench")

CSV_COLUMNS = [
    "timestamp",
    "protocol",
    "endpoint",
    "cloud_provider",
    "cloud_region",
    "pid",
    "cpu_percent",
    "memory_mb",
    "client_memory_percent",
    "client_disk_percent",
    "server_cpu_percent",
    "server_memory_percent",
    "server_disk_percent",
    "encoded_bitrate_kbps",
    "encoder_send_rate_mbps",
    "transport_recv_rate_mbps",
    "fps",
    "fps_stability",
    "speed",
    "encode_lag_ms",
    # One-shot STARTUP measurement (encoder-ready → first confirmed publish),
    # not a per-sample stage. It is deliberately not part of the latency
    # budget below; adding a startup constant to every steady-state sample
    # inflated accounted_ms for whole runs.
    "upload_latency_ms",
    # Per-component latency decomposition (see src/latency_budget.py). The
    # components in scope for this leg's e2e estimator sum to
    # latency_accounted_ms; the signed difference against e2e_latency_ms is
    # split into latency_residual_ms (unexplained) and latency_overcount_ms
    # (over-attributed). latency_unmeasured names stages with no instrument.
    "latency_encode_ms",
    "latency_publish_ms",
    "latency_network_ms",
    "latency_packager_ms",
    "latency_player_buffer_ms",
    "latency_accounted_ms",
    "latency_residual_ms",
    "latency_overcount_ms",
    "latency_unmeasured",
    "latency_e2e_scope",
    # Frame accounting, normalized so encoder and glass use the same
    # denominator convention (see src/latency_budget.py).
    "encode_frames_total",
    "encode_frames_dropped",
    "encode_frames_duped",
    "encode_frame_drop_pct",
    "playback_frame_drop_pct",
    "frame_delivery_pct",
    "out_time",
    "transport_rtt_ms",
    "transport_rtt_jitter_ms",
    "net_rtt_ms",
    "net_jitter_ms",
    "net_send_mbps",
    "net_recv_mbps",
    "net_loss_pct",
    "net_retrans_pct",
    "pkt_rcv_drop",
    "pkt_snd_drop",
    "pkt_snd_loss",
    "pkt_retrans",
    "pkt_fec_extra",
    "ts_continuity_counter_errors",
    "cmaf_fragment_count",
    "cmaf_seq_gap_count",
    "cmaf_tfdt_gap_count",
    "cmaf_tfdt_gap_ms",
    "cmaf_tfdt_overlap_count",
    "cmaf_parse_errors",
    "vmaf_score",
    "psnr_db",
    "ssim",
    "moqx_subscribe_success",
    "moqx_subscribe_error",
    "moqx_publish_namespace_success",
    "moqx_publish_received",
    "moqx_publish_done",
    "quic_rtt_ms",
    "quic_cwnd_bytes",
    "quic_packets_lost",
    "playback_stats_events",
    "playback_stall_count",
    "playback_frames_rendered",
    "playback_frames_dropped",
    "playback_bitrate_bps",
    "playback_ttff_ms",
    "playback_hls_errors",
    "playback_hls_fatal_errors",
    "playback_hls_buffer_stalls",
    "playback_hls_frag_loads",
    "playback_video_time_sec",
    "playback_buffer_sec",
    "playback_rebuffer_sec",
    "playback_error_count",
    "e2e_latency_ms",
]


def parse_out_time_seconds(out_time: str) -> float:
    """Parse ffmpeg out_time (HH:MM:SS.microseconds) to seconds."""
    value = (out_time or "").strip()
    if not value or value == "N/A":
        return 0.0
    try:
        parts = value.split(":")
        if len(parts) != 3:
            return 0.0
        hours = float(parts[0])
        minutes = float(parts[1])
        seconds = float(parts[2])
        return max(0.0, hours * 3600.0 + minutes * 60.0 + seconds)
    except (TypeError, ValueError):
        return 0.0


def compute_encode_lag_ms(wall_elapsed_sec: float, out_time: str) -> float:
    """Raw (wall − out_time) in ms.

    WARNING: this includes the constant startup offset (process spawn, device/
    broker warmup, first-frame delay), which is NOT sustained encoder lag.
    Sample loops should use :class:`EncodeLagTracker`, which baseline-subtracts
    that offset; this raw form is kept for callers that want the absolute gap.
    """
    media_sec = parse_out_time_seconds(out_time)
    if media_sec <= 0 or wall_elapsed_sec <= 0:
        return 0.0
    lag_ms = (wall_elapsed_sec - media_sec) * 1000.0
    if lag_ms < 0 or lag_ms > 120_000:
        return 0.0
    return round(lag_ms, 1)


class EncodeLagTracker:
    """Sustained encoder lag = *growth* of (wall − out_time) past its baseline.

    The raw difference (wall elapsed − media out_time) contains a constant
    startup offset — process spawn, webcam-broker warmup, first-frame latency —
    that a per-second sample loop would re-report forever (~1.2–2.4s on the
    SRT LL-HLS and MoQ webcam paths). That dead time is not encoder lag: the
    encoder is keeping up fine, it just started late. Anchoring at the first
    sample with a positive out_time makes the metric answer the question it is
    charted as: "is the encoder falling further behind realtime?"
    """

    def __init__(self) -> None:
        self._baseline_ms: Optional[float] = None

    def sample(self, wall_elapsed_sec: float, out_time: str) -> float:
        media_sec = parse_out_time_seconds(out_time)
        if media_sec <= 0 or wall_elapsed_sec <= 0:
            return 0.0
        raw_ms = (wall_elapsed_sec - media_sec) * 1000.0
        if raw_ms < 0 or raw_ms > 120_000:
            return 0.0
        if self._baseline_ms is None:
            self._baseline_ms = raw_ms
        return round(max(0.0, raw_ms - self._baseline_ms), 1)

    @property
    def pipeline_baseline_ms(self) -> float:
        """The constant startup offset this tracker subtracts from every sample.

        Not encoder *lag*, but real capture→muxed delay that the glass sees.
        ``latency_budget.encode_latency_ms`` adds it back so the latency
        decomposition accounts for it exactly once instead of dropping it.
        """
        return round(self._baseline_ms or 0.0, 1)


def ffmpeg_bits_ready(out_time: str, total_bytes: int = 0) -> bool:
    """Encode-ready: ffmpeg has muxed at least one packet."""
    return parse_out_time_seconds(out_time) > 0 or int(total_bytes or 0) > 0


class UploadLatencyTracker:
    """Publisher→ingest: encode-ready wall time to first confirmed publish.

    One-shot like TTFF. Not RTT and not glass-to-glass. Stays None until both
    signals exist so the UI can show "—" instead of a fake 0.
    """

    def __init__(self) -> None:
        self._encode_ready_mono: Optional[float] = None
        self._latency_ms: Optional[float] = None

    def note_encode_ready(
        self,
        ready: bool,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ready and self._encode_ready_mono is None:
            self._encode_ready_mono = clock()

    def note_publish_success(
        self,
        success: bool,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> Optional[float]:
        if self._latency_ms is not None:
            return self._latency_ms
        if not success:
            return None
        if self._encode_ready_mono is None:
            self._encode_ready_mono = clock()
        self._latency_ms = max(0.0, round((clock() - self._encode_ready_mono) * 1000.0, 1))
        return self._latency_ms

    @property
    def value_ms(self) -> Optional[float]:
        return self._latency_ms


class MetricsCollector:
    def __init__(
        self,
        protocol: str,
        endpoint_url: str,
        output_dir: str = "results",
        run_id: str = "",
        cloud_provider: str = "",
        cloud_region: str = "",
    ):
        self.protocol = protocol
        self.endpoint_url = endpoint_url
        self.cloud_provider = cloud_provider or ""
        self.cloud_region = cloud_region or ""
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)

        timestamp = time.strftime("%Y%m%d-%H%M%S")
        suffix = f"_{run_id[:8]}" if run_id else ""
        self.filename = os.path.join(self.output_dir, f"upload_{timestamp}{suffix}.csv")
        self.summary_path = os.path.join(
            self.output_dir,
            f"upload_{timestamp}{suffix}.summary.json",
        )
        self._fps_window = RollingWindow(size=30)
        # Fallback encode-lag tracker for callers that don't pass encode_lag_ms
        # explicitly — baseline-subtracted, same semantics as the sample loops.
        self._encode_lag_tracker = EncodeLagTracker()
        self._rows: List[dict] = []
        self._total_bytes_sent = 0
        self._total_bytes_received = 0
        self._peak_bandwidth_sent_mbps = 0.0
        self._peak_bandwidth_recv_mbps = 0.0
        self._run_started_at: Optional[float] = None
        self._last_sample_at: Optional[float] = None
        # Fix 9: psutil cpu_percent(interval=None) measures since the *previous*
        # call on the same Process object; a fresh Process per sample always
        # returned 0.0. Cache handles per pid for the collector's lifetime.
        self._procs: Dict[int, psutil.Process] = {}
        self._init_csv()

    def _init_csv(self) -> None:
        with open(self.filename, mode="w", newline="") as file:
            writer = csv.writer(file)
            writer.writerow(CSV_COLUMNS)

    def record_sample(
        self,
        pid: int,
        encoded_bitrate_kbps: float,
        fps: float,
        speed: float,
        out_time: str,
        *,
        extra_pids: Optional[List[int]] = None,
        transport_rtt_ms: float = 0.0,
        transport_rtt_jitter_ms: float = 0.0,
        pkt_rcv_drop: int = 0,
        pkt_snd_drop: int = 0,
        pkt_snd_loss: int = 0,
        pkt_retrans: int = 0,
        pkt_fec_extra: int = 0,
        ts_continuity_counter_errors: int = 0,
        cmaf_fragment_count: int = 0,
        cmaf_seq_gap_count: int = 0,
        cmaf_tfdt_gap_count: int = 0,
        cmaf_tfdt_gap_ms: float = 0.0,
        cmaf_tfdt_overlap_count: int = 0,
        cmaf_parse_errors: int = 0,
        vmaf_score: Optional[float] = None,
        psnr_db: Optional[float] = None,
        ssim: Optional[float] = None,
        encoder_send_rate_mbps: float = 0.0,
        transport_recv_rate_mbps: float = 0.0,
        client_memory_percent: float = 0.0,
        client_disk_percent: float = 0.0,
        server_cpu_percent: float = 0.0,
        server_memory_percent: float = 0.0,
        server_disk_percent: float = 0.0,
        moqx_subscribe_success: int = 0,
        moqx_subscribe_error: int = 0,
        moqx_publish_namespace_success: int = 0,
        moqx_publish_received: int = 0,
        moqx_publish_done: int = 0,
        quic_rtt_ms: float = 0.0,
        quic_cwnd_bytes: int = 0,
        quic_packets_lost: int = 0,
        playback_stats_events: int = 0,
        playback_stall_count: int = 0,
        playback_frames_rendered: int = 0,
        playback_frames_dropped: int = 0,
        playback_bitrate_bps: float = 0.0,
        playback_ttff_ms: float = 0.0,
        playback_hls_errors: int = 0,
        playback_hls_fatal_errors: int = 0,
        playback_hls_buffer_stalls: int = 0,
        playback_hls_frag_loads: int = 0,
        playback_video_time_sec: float = 0.0,
        playback_buffer_sec: float = 0.0,
        playback_rebuffer_sec: float = 0.0,
        playback_error_count: int = 0,
        e2e_latency_ms: float = 0.0,
        encode_lag_ms: float = 0.0,
        encode_pipeline_baseline_ms: float = 0.0,
        encode_frames_total: int = 0,
        encode_frames_dropped: int = 0,
        encode_frames_duped: int = 0,
        # None means "no instrument on this leg" (Zixi carries no PDT) and is
        # reported as an unmeasured stage; 0.0 means "measured, and it was
        # zero". Do not default a missing instrument to 0.
        packager_transit_ms: Optional[float] = None,
        upload_latency_ms: Optional[float] = None,
        e2e_scope: str = E2E_SCOPE_CAPTURE_TO_GLASS,
        net_rtt_ms: float = 0.0,
        net_jitter_ms: float = 0.0,
        net_send_mbps: float = 0.0,
        net_recv_mbps: float = 0.0,
        net_loss_pct: float = 0.0,
        net_retrans_pct: float = 0.0,
        total_bytes_sent: Optional[int] = None,
    ) -> float:
        fps_stability = 0.0
        if fps > 0:
            self._fps_window.add(fps)
            fps_stability = self._fps_window.coefficient_of_variation()

        try:
            pids = [pid] + (extra_pids or [])
            cpu_total = 0.0
            mem_total = 0.0
            if pid > 0:
                for proc_pid in pids:
                    try:
                        process = self._procs.get(proc_pid)
                        if process is None:
                            process = psutil.Process(proc_pid)
                            self._procs[proc_pid] = process
                            # Prime the CPU window; the first call always reads 0.
                            process.cpu_percent(interval=None)
                        cpu_total += process.cpu_percent(interval=None)
                        mem_total += process.memory_info().rss / (1024 * 1024)
                    except psutil.Error:
                        # Dead/replaced pid: drop the stale handle, keep the row.
                        self._procs.pop(proc_pid, None)
                        continue

            send_mbps = (
                encoder_send_rate_mbps
                if encoder_send_rate_mbps > 0
                else (encoded_bitrate_kbps / 1000.0)
            )
            recv_mbps = transport_recv_rate_mbps

            now = time.time()
            if self._run_started_at is None:
                self._run_started_at = now
            wall_elapsed = max(0.0, now - self._run_started_at)

            # Throughput: prefer the encoder's real cumulative byte counter
            # (ffmpeg -progress total_size). Only fall back to integrating the
            # rate over the *actual* wall delta between samples — the old
            # rate×1s assumption undercounted whenever the loop skipped a tick.
            if total_bytes_sent is not None and total_bytes_sent > 0:
                self._total_bytes_sent = max(self._total_bytes_sent, int(total_bytes_sent))
            elif self._last_sample_at is not None:
                delta_sec = max(0.0, now - self._last_sample_at)
                self._total_bytes_sent += int(send_mbps * 1_000_000 / 8 * delta_sec)
            if self._last_sample_at is not None:
                delta_sec = max(0.0, now - self._last_sample_at)
                self._total_bytes_received += int(recv_mbps * 1_000_000 / 8 * delta_sec)
            self._last_sample_at = now
            self._peak_bandwidth_sent_mbps = max(self._peak_bandwidth_sent_mbps, send_mbps)
            self._peak_bandwidth_recv_mbps = max(self._peak_bandwidth_recv_mbps, recv_mbps)
            resolved_encode_lag = (
                encode_lag_ms
                if encode_lag_ms > 0
                else self._encode_lag_tracker.sample(wall_elapsed, out_time)
            )
            resolved_net_rtt = net_rtt_ms or transport_rtt_ms or quic_rtt_ms
            resolved_net_jitter = net_jitter_ms or transport_rtt_jitter_ms
            resolved_net_send = net_send_mbps or send_mbps
            resolved_net_recv = net_recv_mbps or recv_mbps
            sent_pkts_proxy = max(pkt_snd_loss + pkt_retrans + 1, int(wall_elapsed) * 100)
            resolved_net_loss = net_loss_pct
            if resolved_net_loss <= 0 and (pkt_snd_loss > 0 or quic_packets_lost > 0):
                resolved_net_loss = min(
                    100.0,
                    ((pkt_snd_loss + quic_packets_lost) / sent_pkts_proxy) * 100.0,
                )
            resolved_net_retrans = net_retrans_pct
            if resolved_net_retrans <= 0 and pkt_retrans > 0:
                resolved_net_retrans = min(100.0, (pkt_retrans / sent_pkts_proxy) * 100.0)
            resolved_playback_errors = playback_error_count or (
                playback_hls_errors + playback_hls_fatal_errors
            )
            # The baseline the sample loop's tracker subtracted is real glass
            # delay; fall back to our own tracker when the caller passes
            # encode_lag_ms without it so the component is never silently 0.
            baseline_ms = encode_pipeline_baseline_ms or (
                self._encode_lag_tracker.pipeline_baseline_ms
            )
            budget = build_latency_budget(
                pipeline_baseline_ms=baseline_ms,
                encode_lag_ms=resolved_encode_lag,
                # upload_latency_ms is startup-only and must not enter the
                # per-sample chain; no protocol measures steady-state publish
                # transit yet, so the stage reports as unmeasured.
                publish_transit_ms=None,
                # A protocol with no RTT source at all (MoQ today) must land in
                # `unmeasured`, not report a confident 0 ms network hop.
                net_rtt_ms=resolved_net_rtt if resolved_net_rtt > 0 else None,
                packager_transit_ms=packager_transit_ms,
                playback_buffer_sec=playback_buffer_sec,
                e2e_latency_ms=e2e_latency_ms,
                e2e_scope=e2e_scope,
            )
            # The encoder loop has no player counters, so there is no common
            # window here and frame_delivery_pct stays blank; it is filled in
            # once against merged playback values by
            # playback_metrics._recompute_derived.
            frame_row = build_frame_row(
                encode_frames_total=encode_frames_total,
                encode_frames_dropped=encode_frames_dropped,
                encode_frames_duped=encode_frames_duped,
                playback_frames_rendered=playback_frames_rendered,
                playback_frames_dropped=playback_frames_dropped,
            )

            row = {
                "timestamp": now,
                "protocol": self.protocol,
                "endpoint": self.endpoint_url,
                "cloud_provider": self.cloud_provider,
                "cloud_region": self.cloud_region,
                "pid": pid,
                "cpu_percent": f"{cpu_total:.2f}",
                "memory_mb": f"{mem_total:.2f}",
                "client_memory_percent": f"{client_memory_percent:.2f}",
                "client_disk_percent": f"{client_disk_percent:.2f}",
                "server_cpu_percent": f"{server_cpu_percent:.2f}",
                "server_memory_percent": f"{server_memory_percent:.2f}",
                "server_disk_percent": f"{server_disk_percent:.2f}",
                "encoded_bitrate_kbps": f"{encoded_bitrate_kbps:.2f}",
                "encoder_send_rate_mbps": f"{send_mbps:.3f}",
                "transport_recv_rate_mbps": f"{recv_mbps:.3f}",
                "fps": f"{fps:.2f}",
                "fps_stability": f"{fps_stability:.4f}",
                "speed": f"{speed:.2f}",
                "encode_lag_ms": f"{resolved_encode_lag:.1f}",
                "upload_latency_ms": (
                    "" if upload_latency_ms is None else f"{float(upload_latency_ms):.1f}"
                ),
                **budget.as_row(),
                **frame_row,
                "out_time": out_time,
                "transport_rtt_ms": f"{transport_rtt_ms:.3f}",
                "transport_rtt_jitter_ms": f"{transport_rtt_jitter_ms:.3f}",
                "net_rtt_ms": f"{resolved_net_rtt:.3f}",
                "net_jitter_ms": f"{resolved_net_jitter:.3f}",
                "net_send_mbps": f"{resolved_net_send:.3f}",
                "net_recv_mbps": f"{resolved_net_recv:.3f}",
                "net_loss_pct": f"{resolved_net_loss:.3f}",
                "net_retrans_pct": f"{resolved_net_retrans:.3f}",
                "pkt_rcv_drop": str(pkt_rcv_drop),
                "pkt_snd_drop": str(pkt_snd_drop),
                "pkt_snd_loss": str(pkt_snd_loss),
                "pkt_retrans": str(pkt_retrans),
                "pkt_fec_extra": str(pkt_fec_extra),
                "ts_continuity_counter_errors": str(ts_continuity_counter_errors),
                "cmaf_fragment_count": str(cmaf_fragment_count),
                "cmaf_seq_gap_count": str(cmaf_seq_gap_count),
                "cmaf_tfdt_gap_count": str(cmaf_tfdt_gap_count),
                "cmaf_tfdt_gap_ms": f"{cmaf_tfdt_gap_ms:.3f}",
                "cmaf_tfdt_overlap_count": str(cmaf_tfdt_overlap_count),
                "cmaf_parse_errors": str(cmaf_parse_errors),
                "vmaf_score": "" if vmaf_score is None else f"{vmaf_score:.3f}",
                "psnr_db": "" if psnr_db is None else f"{psnr_db:.3f}",
                "ssim": "" if ssim is None else f"{ssim:.4f}",
                "moqx_subscribe_success": str(moqx_subscribe_success),
                "moqx_subscribe_error": str(moqx_subscribe_error),
                "moqx_publish_namespace_success": str(moqx_publish_namespace_success),
                "moqx_publish_received": str(moqx_publish_received),
                "moqx_publish_done": str(moqx_publish_done),
                "quic_rtt_ms": f"{quic_rtt_ms:.3f}",
                "quic_cwnd_bytes": str(quic_cwnd_bytes),
                "quic_packets_lost": str(quic_packets_lost),
                "playback_stats_events": str(playback_stats_events),
                "playback_stall_count": str(playback_stall_count),
                "playback_frames_rendered": str(playback_frames_rendered),
                "playback_frames_dropped": str(playback_frames_dropped),
                "playback_bitrate_bps": f"{playback_bitrate_bps:.0f}",
                "playback_ttff_ms": f"{playback_ttff_ms:.0f}",
                "playback_hls_errors": str(playback_hls_errors),
                "playback_hls_fatal_errors": str(playback_hls_fatal_errors),
                "playback_hls_buffer_stalls": str(playback_hls_buffer_stalls),
                "playback_hls_frag_loads": str(playback_hls_frag_loads),
                "playback_video_time_sec": f"{playback_video_time_sec:.3f}",
                "playback_buffer_sec": f"{playback_buffer_sec:.3f}",
                "playback_rebuffer_sec": f"{playback_rebuffer_sec:.3f}",
                "playback_error_count": str(resolved_playback_errors),
                "e2e_latency_ms": f"{e2e_latency_ms:.0f}",
            }
            self._rows.append(row)

            with open(self.filename, mode="a", newline="") as file:
                writer = csv.DictWriter(file, fieldnames=CSV_COLUMNS)
                writer.writerow(row)
        except psutil.NoSuchProcess:
            logger.warning("Process %s no longer exists.", pid)
        except Exception as exc:
            logger.error("Failed to record metrics: %s", exc)

        return fps_stability

    def write_summary(
        self,
        *,
        vmaf_score: Optional[float] = None,
        psnr_db: Optional[float] = None,
        ssim: Optional[float] = None,
        srt_summary: Optional[SrtStatsSummary] = None,
        quality: Optional[Dict] = None,
        extra: Optional[Dict] = None,
    ) -> str:
        averages = self._compute_averages()
        if vmaf_score is not None:
            averages["vmaf_score"] = vmaf_score
        if psnr_db is not None:
            averages["psnr_db"] = psnr_db
        if ssim is not None:
            averages["ssim"] = ssim

        payload = {
            "csv_path": self.filename,
            "protocol": self.protocol,
            "endpoint": self.endpoint_url,
            "samples": len(self._rows),
            "averages": averages,
            # Honesty note: cumulative-counter entries in `averages` (pkt_*,
            # cmaf_*_count, cmaf_tfdt_gap_ms, moqx_*, playback counters/
            # rebuffer) are run TOTALS taken from the last sample, not means.
            "averages_note": (
                "Cumulative counter fields (pkt_*, cmaf_*, moqx_*, encode_frames_*, "
                "playback counters, playback_rebuffer_sec, cmaf_tfdt_gap_ms) are run "
                "totals from the final sample, not per-sample averages. "
                "e2e_latency_max_ms is the worst observed sample, taken before the "
                "outlier trim that produces e2e_latency_ms."
            ),
            "srt": srt_summary.__dict__ if srt_summary else {},
            "throughput": {
                "total_bytes_sent": self._total_bytes_sent,
                "total_bytes_received": self._total_bytes_received,
                "peak_bandwidth_sent_mbps": round(self._peak_bandwidth_sent_mbps, 3),
                "peak_bandwidth_received_mbps": round(self._peak_bandwidth_recv_mbps, 3),
            },
            "extra": extra or {},
        }
        if quality:
            payload["quality"] = quality

        with open(self.summary_path, mode="w") as file:
            json.dump(payload, file, indent=2)

        return self.summary_path

    def _compute_averages(self) -> Dict[str, float]:
        if not self._rows:
            return {}

        numeric_keys = [
            "cpu_percent",
            "memory_mb",
            "client_memory_percent",
            "client_disk_percent",
            "server_cpu_percent",
            "server_memory_percent",
            "server_disk_percent",
            "encoded_bitrate_kbps",
            "encoder_send_rate_mbps",
            "transport_recv_rate_mbps",
            "fps",
            "fps_stability",
            "speed",
            "encode_lag_ms",
            "latency_encode_ms",
            "latency_publish_ms",
            "latency_network_ms",
            "latency_packager_ms",
            "latency_player_buffer_ms",
            "latency_accounted_ms",
            "latency_residual_ms",
            "latency_overcount_ms",
            "encode_frame_drop_pct",
            "playback_frame_drop_pct",
            "transport_rtt_ms",
            "transport_rtt_jitter_ms",
            "net_rtt_ms",
            "net_jitter_ms",
            "net_send_mbps",
            "net_recv_mbps",
            "net_loss_pct",
            "net_retrans_pct",
            "quic_rtt_ms",
            "quic_cwnd_bytes",
            "playback_bitrate_bps",
            "playback_ttff_ms",
            "playback_video_time_sec",
            "playback_buffer_sec",
            "e2e_latency_ms",
            "psnr_db",
            "ssim",
        ]
        count = len(self._rows)
        averages: Dict[str, float] = {}
        for key in numeric_keys:
            averages[key] = round(
                sum(float(row.get(key, 0) or 0) for row in self._rows) / count,
                3,
            )
        # Headline fps from the frame COUNTER over wall time, not from the mean
        # of ffmpeg's instantaneous `fps=` readings.
        #
        # The per-sample rate is honest — the MoQ publisher pipe applies
        # backpressure, so ffmpeg genuinely alternates ~24.9 and ~37.4 fps
        # (fps_stability, the coefficient of variation, is the metric that
        # reports that, and it correctly reads 0.198 on MoQ vs 0.019 on SRT).
        # What is not honest is averaging an instantaneous rate over unequal
        # sample intervals: it over-weights the short fast ticks and reported
        # 32.2-32.7 fps for a 30fps source on every MoQ leg (2026-08-22), and
        # 31.7 on WebRTC. The counter is exact and interval-independent:
        # 29.78 and 29.75 for those same MoQ legs.
        frames = [
            float(row["encode_frames_total"])
            for row in self._rows
            if str(row.get("encode_frames_total", "")).strip() not in ("", "0")
        ]
        stamps = [
            float(row["timestamp"])
            for row in self._rows
            if str(row.get("timestamp", "")).strip() != ""
        ]
        if len(frames) > 1 and len(stamps) > 1:
            wall_sec = max(stamps) - min(stamps)
            produced = max(frames) - min(frames)
            if wall_sec > 0 and produced > 0:
                averages["fps"] = round(produced / wall_sec, 3)

        # frame_delivery_pct is blank on samples with no common encoder/player
        # window. Averaging blanks as 0 would report "nothing was delivered"
        # for "not yet comparable", so only real values count.
        delivery = [
            float(row["frame_delivery_pct"])
            for row in self._rows
            if str(row.get("frame_delivery_pct", "")).strip() not in ("", "0.00")
        ]
        if delivery:
            averages["frame_delivery_pct"] = round(sum(delivery) / len(delivery), 3)

        # upload_latency_ms is a ONE-SHOT startup measurement (encoder-ready →
        # first confirmed publish) that the sample loop repeats verbatim once
        # settled. The settled value is the measurement, so the last one is
        # taken deliberately — this is not a mean and must not be read as a
        # per-sample publish stage (see latency_budget.build_latency_budget).
        latencies = [
            float(row["upload_latency_ms"])
            for row in self._rows
            if row.get("upload_latency_ms") not in (None, "")
        ]
        if latencies:
            averages["upload_latency_ms"] = round(latencies[-1], 3)

        if self._rows:
            for counter_key in (
                "pkt_rcv_drop",
                "pkt_snd_drop",
                "pkt_snd_loss",
                "pkt_retrans",
                "pkt_fec_extra",
                "ts_continuity_counter_errors",
                "cmaf_fragment_count",
                "cmaf_seq_gap_count",
                "cmaf_tfdt_gap_count",
                "cmaf_tfdt_overlap_count",
                "cmaf_parse_errors",
                "moqx_subscribe_success",
                "moqx_subscribe_error",
                "moqx_publish_namespace_success",
                "moqx_publish_received",
                "moqx_publish_done",
                "quic_packets_lost",
                "encode_frames_total",
                "encode_frames_dropped",
                "encode_frames_duped",
                "playback_stats_events",
                "playback_stall_count",
                "playback_frames_rendered",
                "playback_frames_dropped",
                "playback_hls_errors",
                "playback_hls_fatal_errors",
                "playback_hls_buffer_stalls",
                "playback_hls_frag_loads",
                "playback_error_count",
            ):
                averages[counter_key] = int(float(self._rows[-1].get(counter_key, 0) or 0))
            # Cumulative values (not plain counts) — keep sub-second precision.
            averages["playback_rebuffer_sec"] = round(
                float(self._rows[-1].get("playback_rebuffer_sec", 0) or 0), 3
            )
            averages["cmaf_tfdt_gap_ms"] = round(
                float(self._rows[-1].get("cmaf_tfdt_gap_ms", 0) or 0), 3
            )

        return averages

    def summarize_srt(self) -> SrtStatsSummary:
        return summarize_srt_rows(self._rows)
