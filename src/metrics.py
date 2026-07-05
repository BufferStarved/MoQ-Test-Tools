# src/metrics.py
import csv
import time
import os
import psutil
import logging

logger = logging.getLogger("MoQ-SRT-Bench")

class MetricsCollector:
    def __init__(self, output_dir: str = "results"):
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)
        
        # Create a unique filename based on the test start time
        timestamp = time.strftime("%Y%m%d-%H%M%S")
        self.filename = os.path.join(self.output_dir, f"benchmark_{timestamp}.csv")
        
        self._init_csv()

    def _init_csv(self):
        """Initializes the CSV file with headers."""
        with open(self.filename, mode='w', newline='') as file:
            writer = csv.writer(file)
            writer.writerow(["timestamp", "protocol", "pid", "cpu_percent", "memory_mb"])
        logger.info(f"Metrics logging initialized: {self.filename}")

    def record_process_metrics(self, protocol_name: str, pid: int):
        """Samples the process and writes a row to the CSV."""
        try:
            p = psutil.Process(pid)
            # interval=None is non-blocking after the first call
            cpu = p.cpu_percent(interval=None) 
            mem = p.memory_info().rss / (1024 * 1024)  # Convert bytes to MB
            
            with open(self.filename, mode='a', newline='') as file:
                writer = csv.writer(file)
                writer.writerow([time.time(), protocol_name, pid, f"{cpu:.2f}", f"{mem:.2f}"])
                
        except psutil.NoSuchProcess:
            logger.warning(f"Process {pid} for {protocol_name} no longer exists.")
        except Exception as e:
            logger.error(f"Failed to record metrics for {protocol_name}: {e}")
