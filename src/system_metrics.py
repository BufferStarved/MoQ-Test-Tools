import os
import threading
from dataclasses import dataclass
from typing import Optional

import psutil


@dataclass
class HostMetricsSnapshot:
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    disk_percent: float = 0.0


def _cpu_percent_between(t1, t2) -> float:
    """Host CPU busy percentage between two psutil.cpu_times() snapshots."""
    start = t1._asdict()
    end = t2._asdict()
    total = 0.0
    idle = 0.0
    for key, value in end.items():
        # Linux already folds guest/guest_nice into user/nice.
        if key in ("guest", "guest_nice"):
            continue
        delta = max(0.0, value - start.get(key, 0.0))
        total += delta
        if key in ("idle", "iowait"):
            idle += delta
    if total <= 0:
        return 0.0
    busy_pct = (total - idle) / total * 100.0
    return round(min(100.0, max(0.0, busy_pct)), 1)


class HostCpuTracker:
    """Host CPU sampler with a private measurement baseline.

    psutil.cpu_percent(interval=None) keeps a single cached snapshot per
    *thread*, shared by every caller in that thread. The SRT/MediaMTX sample
    loop read client host metrics and then the co-located "server" host
    metrics back-to-back each second, so the second caller always measured a
    ~0 ms window and reported a flat 0.0 CPU. Each consumer owns one tracker
    so their measurement windows cannot collide.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Prime the window at construction so the first read spans a real
        # interval instead of returning a meaningless 0.0.
        self._last = psutil.cpu_times()

    def cpu_percent(self) -> float:
        current = psutil.cpu_times()
        with self._lock:
            previous, self._last = self._last, current
        return _cpu_percent_between(previous, current)


def read_client_host_metrics(
    cpu_tracker: Optional[HostCpuTracker] = None,
) -> HostMetricsSnapshot:
    memory = psutil.virtual_memory()
    disk_path = os.environ.get("MOQ_DISK_PATH", "/")
    try:
        disk = psutil.disk_usage(disk_path)
        disk_percent = disk.percent
    except OSError:
        disk_percent = 0.0

    cpu_percent = (
        cpu_tracker.cpu_percent()
        if cpu_tracker is not None
        else psutil.cpu_percent(interval=None)
    )
    return HostMetricsSnapshot(
        cpu_percent=cpu_percent,
        memory_percent=memory.percent,
        disk_percent=disk_percent,
    )
