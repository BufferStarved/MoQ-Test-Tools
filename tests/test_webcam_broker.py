"""publisher_agent.webcam_broker: shared camera capture for local-publisher jobs."""

from __future__ import annotations

import shutil
import socket
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from publisher_agent.webcam_broker import (  # noqa: E402
    PREFERRED_LANDSCAPE_VIDEO_SIZE,
    WebcamBroker,
)
from destinations import DestinationProfile  # noqa: E402
from upload_service import UploadJob  # noqa: E402

HAS_FFMPEG = bool(shutil.which("ffmpeg")) or Path(
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
).is_file()


class LandscapeRetryTests(unittest.TestCase):
    """Regression test for the 2026-08-06 portrait-video incident.

    Some MacBook cameras default to a portrait native AVFoundation capture
    mode when no size is requested. The broker should prefer an explicit
    landscape size, but fall back to the device default (not fail the whole
    comparison) when a camera/driver rejects the requested size.
    """

    def _broker_with_fake_spawn(self, outcomes, fail_stderr=None):
        """outcomes: list of "ok" | "fail", one per expected _spawn_capture call."""
        broker = WebcamBroker()
        calls = []
        default_fail = (
            b"Selected framerate (30.000000) is not supported by the device. "
            b"Supported modes: 1920x1080@[60.000000 60.000000]fps"
        )

        def fake_spawn(media_path, ports, *, video_size, framerate="30"):
            calls.append((video_size, framerate))
            outcome = outcomes[len(calls) - 1]
            stderr = b"" if outcome == "ok" else (fail_stderr if fail_stderr is not None else default_fail)
            proc = MakeFakeProcess(alive=(outcome == "ok"), stderr=stderr)
            return proc

        broker._spawn_capture = fake_spawn  # type: ignore[method-assign]
        return broker, calls

    def test_prefers_landscape_and_succeeds_without_retry(self) -> None:
        broker, calls = self._broker_with_fake_spawn(["ok"])
        url, session = broker.acquire("device:webcam", duration_sec=10)
        self.assertEqual(calls[0][0], PREFERRED_LANDSCAPE_VIDEO_SIZE)
        self.assertEqual(len(calls), 1)
        self.assertIsNone(session.error)
        self.assertTrue(url.startswith("udp://127.0.0.1:"))
        broker.release(session)

    def test_falls_back_to_probed_obs_mode_when_720p30_rejected(self) -> None:
        broker, calls = self._broker_with_fake_spawn(["fail", "ok"])
        url, session = broker.acquire("device:webcam", duration_sec=10)
        self.assertEqual(calls[0][0], PREFERRED_LANDSCAPE_VIDEO_SIZE)
        self.assertEqual(calls[1], ("1920x1080", "60"))
        self.assertIsNone(session.error)
        self.assertTrue(url.startswith("udp://127.0.0.1:"))
        broker.release(session)

    def test_propagates_error_when_all_attempts_fail(self) -> None:
        broker, calls = self._broker_with_fake_spawn(["fail"] * 6)
        with self.assertRaises(RuntimeError):
            broker.acquire("device:webcam", duration_sec=10)
        self.assertGreaterEqual(len(calls), 2)
        self.assertEqual(calls[0][0], PREFERRED_LANDSCAPE_VIDEO_SIZE)

    def test_negotiate_then_1080p60_when_device_lists_no_modes(self) -> None:
        broker, calls = self._broker_with_fake_spawn(
            ["fail", "fail", "ok"],
            fail_stderr=b"Error opening input: Input/output error",
        )
        url, session = broker.acquire("device:webcam", duration_sec=10)
        self.assertEqual(calls[0], (PREFERRED_LANDSCAPE_VIDEO_SIZE, "30"))
        self.assertEqual(calls[1], (None, None))
        self.assertEqual(calls[2], ("1920x1080", "60"))
        self.assertIsNone(session.error)
        self.assertTrue(url.startswith("udp://127.0.0.1:"))
        broker.release(session)


class MakeFakeProcess:
    """Minimal Popen-like stand-in for _check_early_exit()."""

    def __init__(self, *, alive: bool, stderr: bytes | None = None) -> None:
        self._alive = alive
        self.returncode = None if alive else 1
        self.stderr = _FakeStderr(
            b"" if alive else (stderr if stderr is not None else b"camera rejected requested size")
        )

    def poll(self):
        return None if self._alive else self.returncode

    def terminate(self) -> None:
        self._alive = False
        self.returncode = self.returncode or 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self) -> None:
        self._alive = False


class _FakeStderr:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self):
        if isinstance(self._data, bytes):
            return self._data.decode("utf-8", errors="replace")
        return self._data


class TeeMapArgsTests(unittest.TestCase):
    """Regression tests for the 2026-08-06 MoQ-leg starvation incident.

    ffmpeg's tee muxer cannot auto-select streams: without explicit -map the
    master capture opened with zero streams and died ~1s in ("Output file
    does not contain any stream", exit 234), so every leg reading the broker
    feed timed out on an empty UDP port ("ffmpeg exited with code 251:
    Error opening input files: Input/output error").
    """

    def _captured_spawn_cmd(self, input_args) -> list:
        broker = WebcamBroker()
        captured = {}

        def fake_popen(cmd, **kwargs):
            captured["cmd"] = cmd
            return MakeFakeProcess(alive=True)

        with patch(
            "publisher_agent.webcam_broker.build_device_webcam_input_args",
            return_value=list(input_args),
        ), patch(
            "publisher_agent.webcam_broker.find_ffmpeg",
            return_value="ffmpeg",
        ), patch(
            "publisher_agent.webcam_broker.subprocess.Popen",
            side_effect=fake_popen,
        ):
            broker._spawn_capture("device:webcam", [50000], video_size=None)
        return captured["cmd"]

    def test_macos_style_input_gets_explicit_maps_before_tee(self) -> None:
        # macOS avfoundation: one input ("0:0") carrying both streams, no maps.
        cmd = self._captured_spawn_cmd(
            ["-f", "avfoundation", "-framerate", "30", "-i", "0:0"]
        )
        self.assertIn("-map", cmd)
        map_values = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-map"]
        self.assertEqual(map_values, ["0:v:0", "0:a:0?"])
        self.assertLess(cmd.index("-map"), cmd.index("tee"))

    def test_linux_style_input_with_own_maps_is_not_double_mapped(self) -> None:
        # Linux V4L2 + anullsrc: two inputs with their own explicit maps.
        input_args = [
            "-f", "v4l2", "-i", "/dev/video0",
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-map", "0:v:0", "-map", "1:a:0", "-shortest",
        ]
        cmd = self._captured_spawn_cmd(input_args)
        map_values = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-map"]
        self.assertEqual(map_values, ["0:v:0", "1:a:0"])


class RefreshFfmpegCmdTests(unittest.TestCase):
    """The agent must rebuild the frozen ffmpeg command after the broker
    rewrites job.media_path — otherwise RTMP/SRT direct pipelines reuse the
    construction-time command and open the camera directly, bypassing the
    broker (the other half of the 2026-08-06 incident).
    """

    def _job(self) -> UploadJob:
        return UploadJob(
            media_path="device:webcam",
            destination=DestinationProfile(
                protocol="rtmp",
                url="rtmp://35.222.33.58:1935/live/benchmark",
                preset_id="moq_zixi_gcp_rtmp",
            ),
            duration_sec=30,
        )

    def test_frozen_cmd_uses_device_capture_until_refreshed(self) -> None:
        job = self._job()
        self.assertNotIn("udp://127.0.0.1:50123", " ".join(job.ffmpeg_cmd))

        job.media_path = "udp://127.0.0.1:50123?timeout=15000000&fifo_size=1000000"
        # Still stale: the dataclass does not watch media_path.
        self.assertNotIn("udp://127.0.0.1:50123", " ".join(job.ffmpeg_cmd))

        job.refresh_ffmpeg_cmd()
        joined = " ".join(job.ffmpeg_cmd)
        self.assertIn("udp://127.0.0.1:50123", joined)
        self.assertNotIn("avfoundation", joined)
        self.assertNotIn("v4l2", joined)


@unittest.skipUnless(HAS_FFMPEG, "requires a local ffmpeg build")
class SharedCaptureIntegrationTests(unittest.TestCase):
    """End-to-end: N concurrent legs share exactly one physical capture."""

    def setUp(self) -> None:
        self._patcher = patch(
            "publisher_agent.webcam_broker.build_device_webcam_input_args",
            side_effect=self._fake_input_args,
        )
        self._patcher.start()
        self.addCleanup(self._patcher.stop)
        self.broker = WebcamBroker()

    @staticmethod
    def _fake_input_args(*, duration_sec=None, device_index=None, video_size=None, framerate="30"):
        # Mirrors the real Linux V4L2+Pulse shape (two -i's + explicit -map);
        # exercises the same code path as a real device without needing a
        # camera. video_size is accepted (matches the real signature) but
        # unused here — a synthetic source doesn't need a landscape retry.
        return [
            "-f", "lavfi", "-i", "testsrc=size=640x360:rate=15",
            "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
            "-map", "0:v:0", "-map", "1:a:0", "-shortest",
        ]

    def test_three_legs_share_one_capture_and_get_distinct_ports(self) -> None:
        results = {}
        errors = {}

        def leg(name):
            try:
                results[name] = self.broker.acquire("device:webcam", duration_sec=8)
            except Exception as exc:  # noqa: BLE001
                errors[name] = exc

        threads = [
            threading.Thread(target=leg, args=(n,)) for n in ("rtmp", "srt", "moq")
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=20)

        self.assertEqual(errors, {})
        self.assertEqual(len(results), 3)

        ports = set()
        sessions = set()
        for url, session in results.values():
            self.assertTrue(url.startswith("udp://127.0.0.1:"))
            port = int(url.split(":")[-1].split("?")[0])
            ports.add(port)
            sessions.add(id(session))
        self.assertEqual(len(ports), 3, "each leg should get its own port")
        self.assertEqual(len(sessions), 1, "all legs should share one session/process")

        for port in ports:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(("127.0.0.1", port))
            sock.settimeout(5)
            try:
                data, _ = sock.recvfrom(4096)
                self.assertGreater(len(data), 0)
            finally:
                sock.close()

        for _url, session in results.values():
            self.broker.release(session)
        time.sleep(1)
        with self.broker._sessions_lock:
            self.assertEqual(self.broker._sessions, {}, "session should be cleaned up")


@unittest.skipUnless(HAS_FFMPEG, "requires a local ffmpeg build")
class MapFreeInputIntegrationTests(unittest.TestCase):
    """End-to-end regression for 2026-08-06: a macOS-shaped input (single
    ``-i`` carrying both streams, no ``-map``) must still produce packets on
    the subscriber port — without the broker's explicit maps the tee muxer
    starts with zero streams and the master dies ~1s in, silently.
    """

    def test_subscriber_receives_packets_from_map_free_input(self) -> None:
        with patch(
            "publisher_agent.webcam_broker.build_device_webcam_input_args",
            return_value=[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=640x360:rate=15[out0];"
                "sine=frequency=1000:sample_rate=48000[out1]",
            ],
        ):
            broker = WebcamBroker()
            url, session = broker.acquire("device:webcam", duration_sec=8)
            port = int(url.split(":")[2].split("?")[0])
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.bind(("127.0.0.1", port))
            sock.settimeout(8)
            try:
                data, _ = sock.recvfrom(4096)
                self.assertGreater(len(data), 0)
                self.assertEqual(data[0], 0x47, "expected an MPEG-TS sync byte")
            finally:
                sock.close()
                broker.release(session)


if __name__ == "__main__":
    unittest.main()
