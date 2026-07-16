import logging
import os
import shutil
import threading
import time
from dataclasses import dataclass
from typing import IO, Optional

logger = logging.getLogger("MoQ-SRT-Bench")


@dataclass
class UploadStatus:
    frame: int = 0
    fps: float = 0.0
    bitrate_kbps: float = 0.0
    out_time: str = "00:00:00.000000"
    speed: float = 0.0
    progress: str = "unknown"

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


class FfmpegProgressReader:
    """Reads ffmpeg -progress output and tracks encode/upload status."""

    def __init__(self, pipe: IO[bytes]):
        self._pipe = pipe
        self._status = UploadStatus()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _apply_line(self, line: str) -> None:
        if "=" not in line:
            return

        key, value = line.split("=", 1)
        with self._lock:
            if key == "frame":
                self._status.frame = int(float(value))
            elif key == "fps":
                self._status.fps = float(value)
            elif key == "bitrate" and "N/A" not in value:
                self._status.bitrate_kbps = float(value.replace("kbits/s", "").strip())
            elif key == "out_time":
                self._status.out_time = value
            elif key == "speed" and "N/A" not in value:
                self._status.speed = float(value.replace("x", "").strip())
            elif key == "progress":
                self._status.progress = value

    def _read_loop(self) -> None:
        try:
            for raw_line in iter(self._pipe.readline, b""):
                self._apply_line(raw_line.decode("utf-8", errors="replace").strip())
        except Exception as exc:
            logger.warning("Progress reader stopped: %s", exc)
        finally:
            self._pipe.close()

    def get_status(self) -> UploadStatus:
        with self._lock:
            return UploadStatus(
                frame=self._status.frame,
                fps=self._status.fps,
                bitrate_kbps=self._status.bitrate_kbps,
                out_time=self._status.out_time,
                speed=self._status.speed,
                progress=self._status.progress,
            )


class FfmpegProgressFileReader:
    """Reads ffmpeg -progress output written to a file."""

    def __init__(self, progress_path: str):
        self._progress_path = progress_path
        self._status = UploadStatus()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()

    def _apply_line(self, line: str) -> None:
        if "=" not in line:
            return

        key, value = line.split("=", 1)
        with self._lock:
            if key == "frame":
                self._status.frame = int(float(value))
            elif key == "fps":
                self._status.fps = float(value)
            elif key == "bitrate" and "N/A" not in value:
                self._status.bitrate_kbps = float(value.replace("kbits/s", "").strip())
            elif key == "out_time":
                self._status.out_time = value
            elif key == "speed" and "N/A" not in value:
                self._status.speed = float(value.replace("x", "").strip())
            elif key == "progress":
                self._status.progress = value

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
                        self._apply_line(raw_line.strip())
                    position = file.tell()
            except OSError as exc:
                logger.warning("Progress file reader stopped: %s", exc)
                return

            time.sleep(0.2)

    def get_status(self) -> UploadStatus:
        with self._lock:
            return UploadStatus(
                frame=self._status.frame,
                fps=self._status.fps,
                bitrate_kbps=self._status.bitrate_kbps,
                out_time=self._status.out_time,
                speed=self._status.speed,
                progress=self._status.progress,
            )


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
