import logging
import os
import shutil
import threading
import time
from dataclasses import dataclass
from typing import IO, Callable, Optional

logger = logging.getLogger("MoQ-SRT-Bench")


def _parse_out_time_sec(out_time: str) -> float:
    value = (out_time or "").strip()
    if not value or value == "N/A":
        return 0.0
    parts = value.split(":")
    if len(parts) != 3:
        return 0.0
    try:
        return max(
            0.0,
            float(parts[0]) * 3600.0 + float(parts[1]) * 60.0 + float(parts[2]),
        )
    except (TypeError, ValueError):
        return 0.0


def _format_out_time(seconds: float) -> str:
    """HH:MM:SS.microseconds from a media-clock second count."""
    total = max(0.0, float(seconds))
    hours = int(total // 3600.0)
    minutes = int((total % 3600.0) // 60.0)
    secs = total - hours * 3600.0 - minutes * 60.0
    return f"{hours:02d}:{minutes:02d}:{secs:09.6f}"


@dataclass
class UploadStatus:
    frame: int = 0
    fps: float = 0.0
    bitrate_kbps: float = 0.0
    out_time: str = "00:00:00.000000"
    speed: float = 0.0
    progress: str = "unknown"
    # Cumulative muxed output bytes (ffmpeg -progress total_size).
    total_bytes: int = 0
    # ffmpeg's own exact frame accounting. drop_frames is the encoder-side
    # counterpart to the player's droppedVideoFrames; dup_frames is what CFR
    # normalization inserted for a VFR source (a duplicated frame is not a
    # delivered frame, so it belongs in the frame budget too).
    drop_frames: int = 0
    dup_frames: int = 0

    def display_line(self, elapsed_sec: int, cpu_percent: float, memory_mb: float) -> str:
        return (
            f"[{elapsed_sec:>3}s] {self.out_time} | "
            f"{self.bitrate_kbps:>7.0f} kbps | "
            f"{self.fps:>5.1f} fps | "
            f"speed {self.speed:>4.2f}x | "
            f"CPU {cpu_percent:>5.1f}% | "
            f"MEM {memory_mb:>6.1f} MB"
        )

    def display_line_extended(
        self,
        elapsed_sec: int,
        cpu_percent: float,
        memory_mb: float,
        *,
        rtt_ms: float = 0.0,
        rtt_jitter_ms: float = 0.0,
        pkt_retrans: int = 0,
        fps_stability: float = 0.0,
    ) -> str:
        network = ""
        if rtt_ms > 0:
            network = (
                f" | RTT {rtt_ms:>5.1f}ms"
                f" jitter {rtt_jitter_ms:>4.2f}ms"
                f" retx {pkt_retrans}"
            )
        stability = f" | fpsσ {fps_stability:.4f}" if fps_stability > 0 else ""
        return self.display_line(elapsed_sec, cpu_percent, memory_mb) + network + stability


class ProgressDeltaTracker:
    """Parses ffmpeg -progress lines and reports *instantaneous* rates.

    ffmpeg's own fps/bitrate/speed values in -progress output are cumulative
    run averages (frame/elapsed, total_size/out_time). Charted per second they
    fabricate trends — a rock-steady 30fps webcam encode drew as a 15→29
    "ramp" because early startup seconds dragged the average. This tracker
    recomputes fps/bitrate/speed from the deltas between consecutive progress
    blocks (Δframes, Δbytes, Δout_time over Δwall) and only falls back to
    ffmpeg's cumulative numbers before the first delta is available.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self._status = UploadStatus()
        self._lock = threading.Lock()
        # Raw cumulative values from the current/last progress block.
        self._raw_frame: Optional[int] = None
        self._raw_total_size: Optional[int] = None
        self._raw_out_time_sec: float = 0.0
        # Previous block snapshot for delta computation.
        self._prev_wall: Optional[float] = None
        self._prev_frame: Optional[int] = None
        self._prev_total_size: Optional[int] = None
        self._prev_out_time_sec: Optional[float] = None
        # ffmpeg's own bitrate= when total_size is N/A (FLV/RTMP muxer).
        self._reported_bitrate_kbps: Optional[float] = None

    def apply_line(self, line: str) -> None:
        if "=" not in line:
            return

        key, value = line.split("=", 1)
        with self._lock:
            try:
                if key == "frame":
                    self._raw_frame = int(float(value))
                    self._status.frame = self._raw_frame
                elif key == "fps" and "N/A" not in value:
                    # Cumulative average — placeholder until deltas exist.
                    if self._prev_wall is None:
                        self._status.fps = float(value)
                elif key == "bitrate" and "N/A" not in value:
                    parsed = float(value.replace("kbits/s", "").strip())
                    self._reported_bitrate_kbps = parsed
                    # Keep ffmpeg's reported rate until total_size deltas exist.
                    # FLV/RTMP often emits bitrate= but total_size=N/A forever
                    # (Zixi RTMP 769d4f4e: 790 frames, bitrate 0/28).
                    if self._prev_wall is None or self._raw_total_size is None:
                        self._status.bitrate_kbps = parsed
                elif key == "total_size" and "N/A" not in value:
                    self._raw_total_size = int(float(value))
                    self._status.total_bytes = self._raw_total_size
                elif key == "drop_frames" and "N/A" not in value:
                    self._status.drop_frames = int(float(value))
                elif key == "dup_frames" and "N/A" not in value:
                    self._status.dup_frames = int(float(value))
                elif key == "out_time_us" and "N/A" not in value:
                    # Modern ffmpeg often emits only out_time_us / out_time_ms.
                    # Without this, MoQ encode_lag_ms and out_time stay empty
                    # even while fps/bitrate advance (comparison CSV 2026-08-18).
                    us = float(value)
                    self._raw_out_time_sec = max(0.0, us / 1_000_000.0)
                    self._status.out_time = _format_out_time(self._raw_out_time_sec)
                elif key == "out_time_ms" and "N/A" not in value:
                    ms = float(value)
                    self._raw_out_time_sec = max(0.0, ms / 1000.0)
                    self._status.out_time = _format_out_time(self._raw_out_time_sec)
                elif key == "out_time":
                    self._status.out_time = value
                    parsed = _parse_out_time_sec(value)
                    if parsed > 0:
                        self._raw_out_time_sec = parsed
                elif key == "speed" and "N/A" not in value:
                    if self._prev_wall is None:
                        self._status.speed = float(value.replace("x", "").strip())
                elif key == "progress":
                    self._status.progress = value
                    self._finish_block()
            except (TypeError, ValueError):
                return

    # File readers can parse several buffered blocks in one poll (startup
    # catch-up); computing a rate over a near-zero wall window would fabricate
    # huge spikes. Blocks closer together than this fold into the next window.
    MIN_DELTA_WINDOW_SEC = 0.2

    def _finish_block(self) -> None:
        """A `progress=` line closes a block — compute deltas vs the previous."""
        now = self._clock()
        if self._prev_wall is not None:
            d_wall = now - self._prev_wall
            if d_wall < self.MIN_DELTA_WINDOW_SEC:
                return
            if self._raw_frame is not None and self._prev_frame is not None:
                self._status.fps = max(0.0, (self._raw_frame - self._prev_frame) / d_wall)
            if self._prev_out_time_sec is not None:
                d_out = self._raw_out_time_sec - self._prev_out_time_sec
                self._status.speed = max(0.0, d_out / d_wall)
                if (
                    self._raw_total_size is not None
                    and self._prev_total_size is not None
                ):
                    d_bytes = max(0, self._raw_total_size - self._prev_total_size)
                    # Encoded media bitrate: bytes per *media* second when the
                    # timeline advanced, else per wall second.
                    denom = d_out if d_out > 0 else d_wall
                    self._status.bitrate_kbps = (d_bytes * 8.0 / denom) / 1000.0
                elif self._reported_bitrate_kbps is not None:
                    self._status.bitrate_kbps = self._reported_bitrate_kbps
        self._prev_wall = now
        self._prev_frame = self._raw_frame
        self._prev_total_size = self._raw_total_size
        self._prev_out_time_sec = self._raw_out_time_sec

    def get_status(self) -> UploadStatus:
        with self._lock:
            return UploadStatus(
                frame=self._status.frame,
                fps=self._status.fps,
                bitrate_kbps=self._status.bitrate_kbps,
                out_time=self._status.out_time,
                speed=self._status.speed,
                progress=self._status.progress,
                total_bytes=self._status.total_bytes,
                drop_frames=self._status.drop_frames,
                dup_frames=self._status.dup_frames,
            )


class FfmpegProgressReader:
    """Reads ffmpeg -progress output from a pipe (instantaneous rates)."""

    def __init__(self, pipe: IO[bytes]):
        self._pipe = pipe
        self._tracker = ProgressDeltaTracker()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _read_loop(self) -> None:
        try:
            for raw_line in iter(self._pipe.readline, b""):
                self._tracker.apply_line(raw_line.decode("utf-8", errors="replace").strip())
        except Exception as exc:
            logger.warning("Progress reader stopped: %s", exc)
        finally:
            self._pipe.close()

    def get_status(self) -> UploadStatus:
        return self._tracker.get_status()


class FfmpegProgressFileReader:
    """Reads ffmpeg -progress output written to a file (instantaneous rates)."""

    def __init__(self, progress_path: str):
        self._progress_path = progress_path
        self._tracker = ProgressDeltaTracker()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _read_loop(self) -> None:
        position = 0
        while True:
            try:
                if not os.path.exists(self._progress_path):
                    time.sleep(0.2)
                    continue

                with open(self._progress_path, mode="r") as file:
                    file.seek(position)
                    for raw_line in file:
                        self._tracker.apply_line(raw_line.strip())
                    position = file.tell()
            except OSError as exc:
                logger.warning("Progress file reader stopped: %s", exc)
                return

            time.sleep(0.2)

    def get_status(self) -> UploadStatus:
        return self._tracker.get_status()


def find_srt_live_transmit() -> Optional[str]:
    candidates = [
        shutil.which("srt-live-transmit"),
        "/usr/bin/srt-live-transmit",
        "/usr/local/bin/srt-live-transmit",
        "/opt/homebrew/bin/srt-live-transmit",
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None
