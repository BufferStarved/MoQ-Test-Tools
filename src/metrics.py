import csv
import json
import logging
import os
import time
from typing import Dict, List, Optional

import psutil

from srt_stats import SrtStatsSummary, summarize_srt_rows
from stats_window import RollingWindow

logger = logging.getLogger("MoQ-SRT-Bench")

CSV_COLUMNS = [
    "timestamp",
    "protocol",
    "endpoint",
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
    "out_time",
    "transport_rtt_ms",
    "transport_rtt_jitter_ms",
    "pkt_rcv_drop",
    "pkt_snd_drop",
    "pkt_snd_loss",
    "pkt_retrans",
    "pkt_fec_extra",
    "ts_continuity_counter_errors",
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
]


class MetricsCollector:
    def __init__(
        self,
        protocol: str,
        endpoint_url: str,
        output_dir: str = "results",
        run_id: str = "",
    ):
        self.protocol = protocol
        self.endpoint_url = endpoint_url
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
        self._rows: List[dict] = []
        self._total_bytes_sent = 0
        self._total_bytes_received = 0
        self._peak_bandwidth_sent_mbps = 0.0
        self._peak_bandwidth_recv_mbps = 0.0
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
                    process = psutil.Process(proc_pid)
                    cpu_total += process.cpu_percent(interval=None)
                    mem_total += process.memory_info().rss / (1024 * 1024)

            send_mbps = (
                encoder_send_rate_mbps
                if encoder_send_rate_mbps > 0
                else (encoded_bitrate_kbps / 1000.0)
            )
            recv_mbps = transport_recv_rate_mbps
            self._total_bytes_sent += int(send_mbps * 1_000_000 / 8)
            self._total_bytes_received += int(recv_mbps * 1_000_000 / 8)
            self._peak_bandwidth_sent_mbps = max(self._peak_bandwidth_sent_mbps, send_mbps)
            self._peak_bandwidth_recv_mbps = max(self._peak_bandwidth_recv_mbps, recv_mbps)

            row = {
                "timestamp": time.time(),
                "protocol": self.protocol,
                "endpoint": self.endpoint_url,
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
                "out_time": out_time,
                "transport_rtt_ms": f"{transport_rtt_ms:.3f}",
                "transport_rtt_jitter_ms": f"{transport_rtt_jitter_ms:.3f}",
                "pkt_rcv_drop": str(pkt_rcv_drop),
                "pkt_snd_drop": str(pkt_snd_drop),
                "pkt_snd_loss": str(pkt_snd_loss),
                "pkt_retrans": str(pkt_retrans),
                "pkt_fec_extra": str(pkt_fec_extra),
                "ts_continuity_counter_errors": str(ts_continuity_counter_errors),
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
            "transport_rtt_ms",
            "transport_rtt_jitter_ms",
            "quic_rtt_ms",
            "quic_cwnd_bytes",
            "playback_bitrate_bps",
            "playback_ttff_ms",
            "playback_video_time_sec",
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

        if self._rows:
            for counter_key in (
                "pkt_rcv_drop",
                "pkt_snd_drop",
                "pkt_snd_loss",
                "pkt_retrans",
                "pkt_fec_extra",
                "ts_continuity_counter_errors",
                "moqx_subscribe_success",
                "moqx_subscribe_error",
                "moqx_publish_namespace_success",
                "moqx_publish_received",
                "moqx_publish_done",
                "quic_packets_lost",
                "playback_stats_events",
                "playback_stall_count",
                "playback_frames_rendered",
                "playback_frames_dropped",
                "playback_hls_errors",
                "playback_hls_fatal_errors",
                "playback_hls_buffer_stalls",
                "playback_hls_frag_loads",
            ):
                averages[counter_key] = int(float(self._rows[-1].get(counter_key, 0) or 0))

        return averages

    def summarize_srt(self) -> SrtStatsSummary:
        return summarize_srt_rows(self._rows)
