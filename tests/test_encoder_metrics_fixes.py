"""Encoder-metric fixes: instantaneous progress deltas, tick scheduling,
and process termination (metrics audit items 6, 7, 11)."""

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from network_metrics import ProgressDeltaTracker  # noqa: E402
from upload_service import UploadService, sleep_until_next_tick  # noqa: E402


class FakeClock:
    def __init__(self, start: float = 100.0):
        self.now = start

    def __call__(self) -> float:
        return self.now


def feed_block(tracker, *, frame, out_time, total_size, fps="0", bitrate="N/A", speed="N/A"):
    tracker.apply_line(f"frame={frame}")
    tracker.apply_line(f"fps={fps}")
    tracker.apply_line(f"bitrate={bitrate}")
    tracker.apply_line(f"total_size={total_size}")
    tracker.apply_line(f"out_time={out_time}")
    tracker.apply_line(f"speed={speed}")
    tracker.apply_line("progress=continue")


class ProgressDeltaTests(unittest.TestCase):
    def test_flat_30fps_is_reported_flat_not_as_ramp(self):
        """Real fps was a flat 30.0 but ffmpeg's cumulative average charted a
        15→29 ramp — instantaneous deltas must report the flat truth."""
        clock = FakeClock()
        tracker = ProgressDeltaTracker(clock=clock)
        # ffmpeg's cumulative fps ramps (startup drag) while real Δ is 30/s.
        cumulative_fps = ["15.0", "20.0", "23.0", "25.0", "26.5"]
        for second, cum in enumerate(cumulative_fps, start=1):
            feed_block(
                tracker,
                frame=30 * second,
                out_time=f"00:00:{second:02d}.000000",
                total_size=250_000 * second,
                fps=cum,
            )
            clock.now += 1.0
            if second >= 2:
                status = tracker.get_status()
                self.assertAlmostEqual(status.fps, 30.0, places=3)
                self.assertAlmostEqual(status.speed, 1.0, places=3)
                # 250 kB per media second → 2000 kbps flat.
                self.assertAlmostEqual(status.bitrate_kbps, 2000.0, places=3)

    def test_cumulative_values_used_until_first_delta(self):
        clock = FakeClock()
        tracker = ProgressDeltaTracker(clock=clock)
        feed_block(tracker, frame=30, out_time="00:00:01.000000", total_size=250_000,
                   fps="15.0", bitrate="2000.0kbits/s", speed="0.5x")
        status = tracker.get_status()
        self.assertAlmostEqual(status.fps, 15.0)
        self.assertAlmostEqual(status.bitrate_kbps, 2000.0)
        self.assertAlmostEqual(status.speed, 0.5)
        self.assertEqual(status.total_bytes, 250_000)

    def test_batched_blocks_fold_into_one_window(self):
        """File readers can parse several buffered blocks at once — near-zero
        wall deltas must not fabricate rate spikes."""
        clock = FakeClock()
        tracker = ProgressDeltaTracker(clock=clock)
        feed_block(tracker, frame=30, out_time="00:00:01.000000", total_size=250_000)
        clock.now += 0.01  # burst: parsed 10ms later
        feed_block(tracker, frame=60, out_time="00:00:02.000000", total_size=500_000)
        clock.now += 0.99
        feed_block(tracker, frame=90, out_time="00:00:03.000000", total_size=750_000)
        status = tracker.get_status()
        # Window is the full second since the first block: (90-30)/1.0 = 60?
        # No — the 10ms block folded, so deltas span block 1 → block 3.
        self.assertAlmostEqual(status.fps, 60.0, places=1)
        self.assertLess(status.fps, 100.0)  # no 3000fps spike

    def test_total_bytes_tracks_cumulative_total_size(self):
        clock = FakeClock()
        tracker = ProgressDeltaTracker(clock=clock)
        feed_block(tracker, frame=30, out_time="00:00:01.000000", total_size=111)
        clock.now += 1.0
        feed_block(tracker, frame=60, out_time="00:00:02.000000", total_size=222)
        self.assertEqual(tracker.get_status().total_bytes, 222)

    def test_out_time_us_only_still_advances_media_clock(self):
        """ffmpeg 6+ can omit HH:MM:SS out_time and only print out_time_us."""
        clock = FakeClock()
        tracker = ProgressDeltaTracker(clock=clock)
        tracker.apply_line("frame=30")
        tracker.apply_line("total_size=250000")
        tracker.apply_line("out_time_us=1000000")
        tracker.apply_line("progress=continue")
        clock.now += 1.0
        tracker.apply_line("frame=60")
        tracker.apply_line("total_size=500000")
        tracker.apply_line("out_time_us=2000000")
        tracker.apply_line("progress=continue")
        status = tracker.get_status()
        self.assertTrue(status.out_time.startswith("00:00:02"))
        self.assertAlmostEqual(status.speed, 1.0, places=3)


class TickSchedulingTests(unittest.TestCase):
    def test_every_integer_second_is_sampled_despite_work_time(self):
        """work+sleep(1) drifted ~0.25s/iter and skipped one second in ~5;
        anchored ticks must hit every integer second."""
        clock = FakeClock(start=1000.0)
        sleeps = []

        def fake_sleep(sec):
            sleeps.append(sec)
            clock.now += sec

        start = clock.now
        elapsed_seen = []
        tick = 1
        for _ in range(10):
            elapsed_seen.append(int(clock.now - start))
            clock.now += 0.3  # probe work
            tick = sleep_until_next_tick(start, tick, now=clock, sleep=fake_sleep)
        self.assertEqual(elapsed_seen, list(range(10)))
        # Each sleep tops the 0.3s of work back up to the 1s boundary.
        for sec in sleeps:
            self.assertAlmostEqual(sec, 0.7, places=6)

    def test_overrun_skips_missed_ticks_without_bursting(self):
        clock = FakeClock(start=1000.0)
        sleeps = []

        def fake_sleep(sec):
            sleeps.append(sec)
            clock.now += sec

        start = clock.now
        clock.now += 2.5  # iteration overran two full slots
        tick = sleep_until_next_tick(start, 1, now=clock, sleep=fake_sleep)
        self.assertEqual(sleeps, [])  # never sleeps when behind
        self.assertEqual(tick, 3)  # next future whole-second tick
        clock.now += 0.2
        tick = sleep_until_next_tick(start, tick, now=clock, sleep=fake_sleep)
        self.assertAlmostEqual(sleeps[0], 0.3, places=6)
        self.assertEqual(tick, 4)

    def test_cancel_event_interrupts_sleep(self) -> None:
        import threading

        clock = FakeClock(start=1000.0)
        cancel = threading.Event()
        cancel.set()
        slept = []

        def fake_sleep(sec):
            slept.append(sec)
            clock.now += sec

        tick = sleep_until_next_tick(
            1000.0, 1, now=clock, sleep=fake_sleep, cancel_event=cancel
        )
        self.assertEqual(slept, [])
        self.assertEqual(tick, 2)


class FakeProcess:
    """Popen stand-in for _terminate_process."""

    def __init__(self, *, stubborn: bool = False):
        self.pid = 4242
        self.terminated = False
        self.killed = False
        self._stubborn = stubborn
        self.stdin = None

    def poll(self):
        return None if not (self.terminated or self.killed) else 0

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        if self._stubborn and not self.killed:
            raise subprocess.TimeoutExpired(cmd="fake", timeout=timeout)
        return 0


class TerminateProcessTests(unittest.TestCase):
    """The whole body used to be dead code under `if process is None: return`,
    so encoders were NEVER terminated and ran past job end."""

    def test_terminates_running_process(self):
        service = UploadService()
        proc = FakeProcess()
        service._terminate_process(proc)
        self.assertTrue(proc.terminated)
        self.assertFalse(proc.killed)

    def test_kills_process_that_ignores_terminate(self):
        service = UploadService()
        proc = FakeProcess(stubborn=True)
        service._terminate_process(proc)
        self.assertTrue(proc.terminated)
        self.assertTrue(proc.killed)

    def test_none_is_a_noop(self):
        UploadService()._terminate_process(None)


class StopMoqPublisherTests(unittest.TestCase):
    """A publisher that is still sending must not be SIGKILL'd."""

    def test_does_not_touch_publisher_while_encode_is_live(self):
        service = UploadService()
        proc = FakeProcess(stubborn=True)
        service._stop_moq_publisher(proc, encode_live=True, was_publishing=True)
        self.assertFalse(proc.terminated)
        self.assertFalse(proc.killed)

    def test_does_not_sigkill_after_connect(self):
        service = UploadService()
        proc = FakeProcess(stubborn=True)
        service._stop_moq_publisher(
            proc, encode_live=False, was_publishing=True, drain_sec=1.0
        )
        self.assertTrue(proc.terminated)
        self.assertFalse(proc.killed)

    def test_may_kill_stubborn_never_connected_publisher(self):
        service = UploadService()
        proc = FakeProcess(stubborn=True)
        service._stop_moq_publisher(
            proc, encode_live=False, was_publishing=False, drain_sec=1.0
        )
        self.assertTrue(proc.terminated)
        self.assertTrue(proc.killed)


if __name__ == "__main__":
    unittest.main()
