import logging
import threading
from dataclasses import dataclass
from typing import IO

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
