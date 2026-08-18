"""SIGTERM / ffmpeg 255 must not be reported as a red encode crash.

BBB cloud comparison 2026-08-18: all four legs showed
``ffmpeg exited with code 255: ... libx264 frame stats ... Exiting
normally, received signal 15``. Signal 15 is SIGTERM (Stop, duration
teardown, or publisher EOF). Exit 255 is ffmpeg catching that kill.
The x264 dump is normal teardown, not a codec crash.
"""

from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import DestinationProfile  # noqa: E402
from upload_service import (  # noqa: E402
    UploadJob,
    UploadService,
    ffmpeg_exit_is_sigterm,
    ffmpeg_stderr_useful_detail,
    sleep_until_next_tick,
)


SIGTERM_STDERR = (
    "frame=  124 fps= 13 q=28.0 size=     256kB time=00:00:04.13 "
    "bitrate= 507.8kbits/s dup=0 drop=119 speed=0.429x elapsed=0:00:09.64\n"
    "x264 [info]: frame I:4     Avg QP:22.12\n"
    "Exiting normally, received signal 15.\n"
)


def _job(*, protocol: str = "rtmp", duration_sec: int = 60, cancelled: bool = False) -> UploadJob:
    job = UploadJob(
        media_path="/tmp/bbb.mp4",
        destination=DestinationProfile(
            protocol=protocol,
            url="rtmp://example.invalid/live/benchmark",
            preset_id="test",
        ),
        duration_sec=duration_sec,
        job_id="sigterm-job",
        cancel_event=threading.Event(),
    )
    if cancelled:
        job.cancel_event.set()
    return job


def _dead_ffmpeg(returncode: int, stderr: bytes) -> MagicMock:
    process = MagicMock()
    process.returncode = returncode
    process.stderr = MagicMock()
    process.stderr.read.return_value = stderr
    return process


class FfmpegSigtermDetectionTests(unittest.TestCase):
    def test_python_negative_signal_code(self) -> None:
        self.assertTrue(ffmpeg_exit_is_sigterm(-15))
        self.assertFalse(ffmpeg_exit_is_sigterm(-9))
        self.assertFalse(ffmpeg_exit_is_sigterm(0))

    def test_shell_128_plus_signal(self) -> None:
        self.assertTrue(ffmpeg_exit_is_sigterm(143))

    def test_ffmpeg_255_with_signal_15_log(self) -> None:
        self.assertTrue(ffmpeg_exit_is_sigterm(255, SIGTERM_STDERR))

    def test_bare_255_is_not_assumed_sigterm(self) -> None:
        self.assertFalse(ffmpeg_exit_is_sigterm(255, "Conversion failed!"))
        self.assertFalse(ffmpeg_exit_is_sigterm(255, ""))

    def test_teardown_dump_is_stripped(self) -> None:
        detail = ffmpeg_stderr_useful_detail(SIGTERM_STDERR)
        self.assertIn("signal 15", detail.lower())
        self.assertNotIn("frame=  124", detail)
        self.assertNotIn("x264 [info]", detail)


class FfmpegExitOutcomeTests(unittest.TestCase):
    def test_user_stop_is_success_not_crash(self) -> None:
        result = UploadService()._ffmpeg_exit_outcome(
            _job(cancelled=True),
            _dead_ffmpeg(255, SIGTERM_STDERR.encode()),
            ran_sec=9.6,
            preview_ready=False,
            had_samples=False,
            encode_speed=0.429,
        )
        self.assertIsNone(result)

    def test_clean_eof_is_success(self) -> None:
        result = UploadService()._ffmpeg_exit_outcome(
            _job(),
            _dead_ffmpeg(0, b""),
            ran_sec=12.0,
        )
        self.assertIsNone(result)

    def test_duration_teardown_sigterm_is_success(self) -> None:
        result = UploadService()._ffmpeg_exit_outcome(
            _job(duration_sec=10),
            _dead_ffmpeg(255, SIGTERM_STDERR.encode()),
            ran_sec=9.6,
            preview_ready=True,
            had_samples=True,
        )
        self.assertIsNone(result)

    def test_unexpected_sigterm_names_the_kill(self) -> None:
        result = UploadService()._ffmpeg_exit_outcome(
            _job(protocol="rtmp", duration_sec=60),
            _dead_ffmpeg(255, SIGTERM_STDERR.encode()),
            ran_sec=9.6,
            preview_ready=False,
            had_samples=False,
            encode_speed=0.429,
        )
        self.assertIsNotNone(result)
        assert result is not None
        self.assertFalse(result.success)
        error = result.error or ""
        self.assertIn("SIGTERM", error)
        self.assertIn("not a codec crash", error)
        self.assertIn("0.43x", error)
        self.assertIn("watchdog", error)
        self.assertIn("playable preview", error)
        self.assertNotIn("frame=  124", error)
        self.assertNotIn("exited with code 255", error)

    def test_real_muxer_failure_keeps_useful_lines(self) -> None:
        process = _dead_ffmpeg(
            69,
            b"Error submitting a packet to the muxer: Immediate exit requested\n"
            b"Conversion failed!\n",
        )
        message = UploadService()._ffmpeg_failure_message(process)
        self.assertIn("69", message)
        self.assertIn("Immediate exit requested", message)

    def test_failure_message_does_not_dump_x264_on_sigterm(self) -> None:
        process = _dead_ffmpeg(255, SIGTERM_STDERR.encode())
        message = UploadService()._ffmpeg_failure_message(process)
        self.assertIn("SIGTERM", message)
        self.assertNotIn("frame=  124", message)


class CancelWakesSampleSleepTests(unittest.TestCase):
    def test_cancel_event_skips_the_rest_of_the_tick(self) -> None:
        clock = {"now": 1000.0}

        def now() -> float:
            return clock["now"]

        def sleep(sec: float) -> None:
            raise AssertionError(f"sleep({sec}) should not run when cancel_event is set")

        cancel = threading.Event()
        cancel.set()
        tick = sleep_until_next_tick(
            1000.0, 1, now=now, sleep=sleep, cancel_event=cancel
        )
        self.assertEqual(tick, 2)


if __name__ == "__main__":
    unittest.main()
