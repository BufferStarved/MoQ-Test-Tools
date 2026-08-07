"""server_cpu_percent flat 0.0 on the SRT/MediaMTX local-server path.

psutil.cpu_percent(interval=None) caches ONE baseline snapshot per thread,
shared by every caller in that thread. The SRT sample loop read client host
metrics and then the co-located MediaMTX "server" host metrics back-to-back
each second, so the server-side call always measured a ~0 ms window and wrote
0.0 into every sample. HostCpuTracker gives each consumer a private baseline.
"""

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

import psutil  # noqa: E402

import system_metrics  # noqa: E402
from ingest_host_metrics import IngestHostMetricsPoller  # noqa: E402
from system_metrics import (  # noqa: E402
    HostCpuTracker,
    _cpu_percent_between,
    read_client_host_metrics,
)


# Captured before any test patches psutil.cpu_times.
_TEMPLATE = psutil.cpu_times()


def _times(user: float, idle: float):
    """Build a platform-native scputimes tuple with only user/idle varying."""
    values = {field: 0.0 for field in _TEMPLATE._fields}
    values["user"] = user
    values["idle"] = idle
    return type(_TEMPLATE)(*[values[field] for field in _TEMPLATE._fields])


class FakeCpuTimes:
    """Deterministic psutil.cpu_times() stand-in.

    Calls within the same 'sample tick' return an identical snapshot (the real
    back-to-back timing), and advance() moves the clock between ticks.
    """

    def __init__(self):
        self.user = 100.0
        self.idle = 900.0

    def advance(self, busy: float, idle: float):
        self.user += busy
        self.idle += idle

    def __call__(self, percpu=False):
        assert not percpu
        return _times(self.user, self.idle)


class CpuPercentBetweenTests(unittest.TestCase):
    def test_half_busy_window(self):
        pct = _cpu_percent_between(_times(100.0, 900.0), _times(100.5, 900.5))
        self.assertAlmostEqual(pct, 50.0)

    def test_zero_width_window_reports_zero_not_crash(self):
        snapshot = _times(100.0, 900.0)
        self.assertEqual(_cpu_percent_between(snapshot, snapshot), 0.0)

    def test_clamped_to_0_100(self):
        self.assertEqual(_cpu_percent_between(_times(100.0, 900.0), _times(105.0, 900.0)), 100.0)


class HostCpuTrackerTests(unittest.TestCase):
    def test_private_baseline_survives_interleaved_module_calls(self):
        """The regression scenario: the sample loop calls the module-level
        psutil.cpu_percent (client host) immediately before the tracker
        (server host) every second. The tracker must still see the full
        one-second window, not the ~0 ms since the client call."""
        fake = FakeCpuTimes()
        with mock.patch.object(psutil, "cpu_times", fake):
            tracker = HostCpuTracker()
            for _ in range(3):
                fake.advance(busy=0.25, idle=0.75)  # one second passes, 25% busy
                # Client host read poisons psutil's shared per-thread cache...
                read_client_host_metrics()
                # ...but the tracker keeps its own baseline.
                server_cpu = tracker.cpu_percent()
                self.assertAlmostEqual(server_cpu, 25.0)

    def test_module_level_cpu_percent_still_zeroed_without_tracker(self):
        """Documents the underlying psutil behavior the tracker works around:
        a second same-thread call with no elapsed window reads 0.0."""
        fake = FakeCpuTimes()
        with mock.patch.object(psutil, "cpu_times", fake):
            psutil.cpu_percent(interval=None)
            fake.advance(busy=0.25, idle=0.75)
            psutil.cpu_percent(interval=None)  # the "client host" call
            self.assertEqual(psutil.cpu_percent(interval=None), 0.0)


class IngestPollerLocalPathTests(unittest.TestCase):
    def test_mediamtx_local_path_reports_real_cpu(self):
        fake = FakeCpuTimes()
        with mock.patch.object(psutil, "cpu_times", fake):
            poller = IngestHostMetricsPoller(
                "srt://203.0.113.5:8890?streamid=publish:benchmark",
                ingest_provider="gcp_mediamtx",
                publisher_host="cloud",
            )
            self.assertTrue(poller.enabled)
            samples = []
            for _ in range(3):
                fake.advance(busy=0.1, idle=0.9)  # 10% busy per tick
                read_client_host_metrics()  # the interleaved client call
                snapshot = poller.poll()
                self.assertEqual(snapshot.source, "local")
                samples.append(snapshot.cpu_percent)
        for cpu in samples:
            self.assertAlmostEqual(cpu, 10.0)

    def test_local_publisher_never_reads_laptop_as_server(self):
        poller = IngestHostMetricsPoller(
            "srt://203.0.113.5:8890?streamid=publish:benchmark",
            ingest_provider="gcp_mediamtx",
            publisher_host="local",
        )
        self.assertFalse(poller._use_local)


if __name__ == "__main__":
    unittest.main()
