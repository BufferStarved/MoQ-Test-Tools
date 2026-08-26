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

    def test_flv_without_total_size_keeps_ffmpeg_bitrate(self):
        """RTMP/FLV reports total_size=N/A; dropping bitrate= left 0/28."""
        clock = FakeClock()
        tracker = ProgressDeltaTracker(clock=clock)
        feed_block(
            tracker,
            frame=30,
            out_time="00:00:01.000000",
            total_size="N/A",
            bitrate="3000.0kbits/s",
        )
        clock.now += 1.0
        feed_block(
            tracker,
            frame=60,
            out_time="00:00:02.000000",
            total_size="N/A",
            bitrate="2981.1kbits/s",
        )
        status = tracker.get_status()
        self.assertAlmostEqual(status.bitrate_kbps, 2981.1, places=1)
        self.assertEqual(status.total_bytes, 0)

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


class HeadlineFpsTests(unittest.TestCase):
    """The run's fps average comes from the frame counter, not from the mean of
    ffmpeg's instantaneous `fps=` readings.

    Live evidence (2026-08-22): every MoQ leg reported 32.2-32.7 fps for a 30fps
    source. The per-sample readings were not wrong — the publisher pipe applies
    backpressure, so ffmpeg really does alternate ~24.9 and ~37.4 fps. What was
    wrong is averaging an instantaneous rate over unequal sample intervals: the
    fast ticks are short and the slow ticks are long, so an unweighted mean
    over-weights the fast ones. The frame counter is immune to that.
    """

    def _collector(self, rows):
        import tempfile

        from metrics import MetricsCollector

        with tempfile.TemporaryDirectory() as tmp:
            collector = MetricsCollector("moq", "https://example/x", output_dir=tmp)
            collector._rows = rows
            return collector._compute_averages()

    def test_backpressure_oscillation_does_not_inflate_the_headline(self):
        # Reproduces the Linode MoQ leg: alternating 1.0s/1.5s ticks, 30 fps of
        # media throughout, ffmpeg reporting 37.41 then 24.94.
        rows = []
        stamp, frames = 1000.0, 0
        for index in range(16):
            fast = index % 2 == 0
            step = 1.0 if fast else 1.5
            stamp += step
            frames += int(round(30 * step))
            rows.append(
                {
                    "timestamp": f"{stamp}",
                    "fps": "37.41" if fast else "24.94",
                    "encode_frames_total": str(frames),
                }
            )

        averages = self._collector(rows)
        naive = sum(float(row["fps"]) for row in rows) / len(rows)
        self.assertGreater(naive, 31.0, "precondition: the old mean read high")
        self.assertAlmostEqual(averages["fps"], 30.0, delta=0.2)

    def test_leading_idle_samples_do_not_stretch_the_denominator(self):
        """The counter window and the clock window must be the same window.

        Replay of upload_20260823-014026_f37981b8: the encoder is idle for the
        first two samples, then produces 810 frames over 27.0s of a 29.0s run.
        Counting frames only over the active samples while timing across all of
        them archived 27.933 fps for a leg that held 30.003 — the same
        arithmetic error the QA audit was making in its own checker.
        """
        rows = [
            {"timestamp": "1000.0", "fps": "0.00", "encode_frames_total": "0"},
            {"timestamp": "1001.0", "fps": "0.00", "encode_frames_total": "0"},
        ]
        stamp, frames = 1001.0, 0
        for _ in range(27):
            stamp += 1.0
            frames += 30
            rows.append(
                {
                    "timestamp": f"{stamp}",
                    "fps": "30.00",
                    "encode_frames_total": str(frames),
                }
            )

        # The first active sample already carries 30 frames, so the shared
        # window is 780 frames over the 26.0s between first and last active
        # sample. Timing across all 29 rows instead gives 780/28.0 = 27.86.
        self.assertAlmostEqual(self._collector(rows)["fps"], 30.0, delta=0.2)

    def test_missing_frame_counter_falls_back_to_the_rate_mean(self):
        # Older CSVs and any leg whose encoder never reported `frame=` still
        # need a number; the counter correction must not blank the column.
        rows = [
            {"timestamp": f"{1000.0 + i}", "fps": "29.97", "encode_frames_total": ""}
            for i in range(5)
        ]
        self.assertAlmostEqual(self._collector(rows)["fps"], 29.97, places=2)


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
