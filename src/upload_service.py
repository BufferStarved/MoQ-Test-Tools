import subprocess
import time
import logging
from dataclasses import dataclass, field
from typing import Callable, List, Optional

import psutil

from destinations import DestinationProfile
from metrics import MetricsCollector
from network_metrics import FfmpegProgressReader

logger = logging.getLogger("MoQ-SRT-Bench")


@dataclass
class UploadJob:
    media_path: str
    destination: DestinationProfile
    duration_sec: int
    ffmpeg_cmd: List[str] = field(default_factory=list, init=False)

    def __post_init__(self):
        if not self.ffmpeg_cmd:
            self.ffmpeg_cmd = self._build_ffmpeg_cmd()

    def _build_ffmpeg_cmd(self) -> List[str]:
        return [
            "ffmpeg", "-re", "-i", self.media_path,
            "-c:v", "copy", "-c:a", "copy",
            "-progress", "pipe:1", "-nostats",
            *self.destination.ffmpeg_output_args(),
        ]


@dataclass
class UploadSample:
    elapsed_sec: int
    bitrate_kbps: float
    fps: float
    speed: float
    out_time: str
    cpu_percent: float
    memory_mb: float
    progress: str


@dataclass
class UploadResult:
    success: bool
    csv_path: Optional[str] = None
    error: Optional[str] = None


SampleCallback = Callable[[UploadSample], None]


class UploadService:
    def run(
        self,
        job: UploadJob,
        on_sample: Optional[SampleCallback] = None,
    ) -> UploadResult:
        process: Optional[subprocess.Popen] = None
        progress_reader: Optional[FfmpegProgressReader] = None

        try:
            process = subprocess.Popen(
                job.ffmpeg_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            return UploadResult(success=False, error="ffmpeg not found in PATH")

        progress_reader = FfmpegProgressReader(process.stdout)
        collector = MetricsCollector(
            protocol=job.destination.protocol,
            endpoint_url=job.destination.url,
        )
        start_time = time.time()

        try:
            while time.time() - start_time < job.duration_sec:
                if process.poll() is not None:
                    return UploadResult(
                        success=False,
                        error=f"ffmpeg exited with code {process.returncode}",
                    )

                status = progress_reader.get_status()
                elapsed = int(time.time() - start_time)

                try:
                    proc = psutil.Process(process.pid)
                    cpu = proc.cpu_percent(interval=None)
                    mem = proc.memory_info().rss / (1024 * 1024)
                except (psutil.NoSuchProcess, psutil.Error):
                    cpu, mem = 0.0, 0.0

                sample = UploadSample(
                    elapsed_sec=elapsed,
                    bitrate_kbps=status.bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                    cpu_percent=cpu,
                    memory_mb=mem,
                    progress=status.progress,
                )

                if on_sample:
                    on_sample(sample)

                collector.record_sample(
                    pid=process.pid,
                    bitrate_kbps=status.bitrate_kbps,
                    fps=status.fps,
                    speed=status.speed,
                    out_time=status.out_time,
                )
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Upload interrupted.")
            return UploadResult(success=False, error="Upload interrupted")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)

        return UploadResult(success=True, csv_path=collector.filename)
