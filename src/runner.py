import subprocess
import time
import logging
import psutil
import argparse
from dataclasses import dataclass
from typing import Optional, Dict

from metrics import MetricsCollector

# --- Prod-Ready Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("MoQ-SRT-Bench")

@dataclass
class StreamConfig:
    name: str
    ffmpeg_cmd: list[str]

class BenchmarkRunner:
    def __init__(self, media_path: str, srt_url: str, moq_url: str):
        self.media_path = media_path
        
        # Using UDP mocks since standard homebrew ffmpeg lacks SRT/MOQ support
        self.streams = [
            StreamConfig(
                name="SRT-Mock",
                ffmpeg_cmd=[
                    "ffmpeg", "-re", "-i", self.media_path,
                    "-c:v", "copy", "-c:a", "copy", "-f", "mpegts", 
                    srt_url
                ]
            ),
            StreamConfig(
                name="MOQ-Mock",
                ffmpeg_cmd=[
                    "ffmpeg", "-re", "-i", self.media_path,
                    "-c:v", "copy", "-c:a", "copy", "-f", "mpegts", 
                    moq_url 
                ]
            )
        ]
        self.active_processes: Dict[str, subprocess.Popen] = {}

    def start_streams(self):
        for stream in self.streams:
            logger.info(f"Starting {stream.name} stream...")
            try:
                process = subprocess.Popen(
                    stream.ffmpeg_cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
                self.active_processes[stream.name] = process
                logger.info(f"[{stream.name}] PID: {process.pid} started successfully.")
            except FileNotFoundError:
                logger.error("ffmpeg not found in PATH.")
                self.stop_streams()
                return

    def monitor_and_block(self, duration_sec: int):
        logger.info(f"Monitoring streams for {duration_sec} seconds...")
        start_time = time.time()
        collector = MetricsCollector()
        
        try:
            while time.time() - start_time < duration_sec:
                for name, proc in self.active_processes.items():
                    if proc.poll() is not None:
                        logger.warning(f"[{name}] Stream crashed! Exit code: {proc.returncode}")
                    else:
                        collector.record_process_metrics(name, proc.pid)
                time.sleep(1)
        except KeyboardInterrupt:
            logger.info("Benchmark interrupted.")
        finally:
            self.stop_streams()

    def stop_streams(self):
        logger.info("Tearing down streams...")
        for name, proc in self.active_processes.items():
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=5)
                logger.info(f"[{name}] Stream terminated.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MOQ vs SRT Upload Benchmark (UDP Mock)")
    parser.add_argument("--media", required=True, help="Path to local mp4 file")
    parser.add_argument("--srt-url", default="udp://127.0.0.1:9000", help="Mock SRT target URL")
    parser.add_argument("--moq-url", default="udp://127.0.0.1:9001", help="Mock MOQ target URL")
    parser.add_argument("--duration", type=int, default=30, help="Benchmark duration in seconds")
    
    args = parser.parse_args()
    
    runner = BenchmarkRunner(args.media, args.srt_url, args.moq_url)
    runner.start_streams()
    
    if len(runner.active_processes) > 0:
        runner.monitor_and_block(args.duration)
