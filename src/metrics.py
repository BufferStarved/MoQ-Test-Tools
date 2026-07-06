import csv
import time
import os
import psutil
import logging

logger = logging.getLogger("MoQ-SRT-Bench")


class MetricsCollector:
    def __init__(self, protocol: str, endpoint_url: str, output_dir: str = "results"):
        self.protocol = protocol
        self.endpoint_url = endpoint_url
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)

        timestamp = time.strftime("%Y%m%d-%H%M%S")
        self.filename = os.path.join(self.output_dir, f"upload_{timestamp}.csv")
        self._init_csv()

    def _init_csv(self):
        with open(self.filename, mode="w", newline="") as file:
            writer = csv.writer(file)
            writer.writerow([
                "timestamp",
                "protocol",
                "endpoint",
                "pid",
                "cpu_percent",
                "memory_mb",
                "bitrate_kbps",
                "fps",
                "speed",
                "out_time",
            ])

    def record_sample(
        self,
        pid: int,
        bitrate_kbps: float,
        fps: float,
        speed: float,
        out_time: str,
    ):
        try:
            process = psutil.Process(pid)
            cpu = process.cpu_percent(interval=None)
            mem = process.memory_info().rss / (1024 * 1024)

            with open(self.filename, mode="a", newline="") as file:
                writer = csv.writer(file)
                writer.writerow([
                    time.time(),
                    self.protocol,
                    self.endpoint_url,
                    pid,
                    f"{cpu:.2f}",
                    f"{mem:.2f}",
                    f"{bitrate_kbps:.2f}",
                    f"{fps:.2f}",
                    f"{speed:.2f}",
                    out_time,
                ])
        except psutil.NoSuchProcess:
            logger.warning("Process %s no longer exists.", pid)
        except Exception as exc:
            logger.error("Failed to record metrics: %s", exc)
