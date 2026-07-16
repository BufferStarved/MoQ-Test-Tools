import os
from dataclasses import dataclass

import psutil


@dataclass
class HostMetricsSnapshot:
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    disk_percent: float = 0.0


def read_client_host_metrics() -> HostMetricsSnapshot:
    memory = psutil.virtual_memory()
    disk_path = os.environ.get("MOQ_DISK_PATH", "/")
    try:
        disk = psutil.disk_usage(disk_path)
        disk_percent = disk.percent
    except OSError:
        disk_percent = 0.0

    return HostMetricsSnapshot(
        cpu_percent=psutil.cpu_percent(interval=None),
        memory_percent=memory.percent,
        disk_percent=disk_percent,
    )
