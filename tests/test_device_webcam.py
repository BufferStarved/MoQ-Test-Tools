"""Local publisher webcam / live media input helpers."""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

from moq_publish import (  # noqa: E402
    DEVICE_WEBCAM_MEDIA,
    build_device_webcam_input_args,
    build_ffmpeg_input_args,
    device_webcam_index,
    is_device_webcam_source,
    is_live_media_source,
)


class DeviceWebcamTests(unittest.TestCase):
    def test_detects_webcam_aliases(self) -> None:
        self.assertTrue(is_device_webcam_source(DEVICE_WEBCAM_MEDIA))
        self.assertTrue(is_device_webcam_source("device:webcam:0"))
        self.assertFalse(is_device_webcam_source("dummy.mp4"))
        self.assertFalse(is_device_webcam_source("udp://127.0.0.1:5000"))

    def test_live_includes_webcam_and_udp(self) -> None:
        self.assertTrue(is_live_media_source("device:webcam"))
        self.assertTrue(is_live_media_source("udp://127.0.0.1:5000"))
        self.assertFalse(is_live_media_source("dummy.mp4"))

    def test_macos_avfoundation_args(self) -> None:
        with patch("platform.system", return_value="Darwin"), patch.dict(
            os.environ, {"LOCAL_WEBCAM_AVFOUNDATION": "1:0"}, clear=False
        ):
            args = build_device_webcam_input_args(duration_sec=8)
        self.assertEqual(args[0:4], ["-f", "avfoundation", "-framerate", "30"])
        self.assertIn("-t", args)
        self.assertEqual(args[args.index("-t") + 1], "8")
        self.assertEqual(args[args.index("-i") + 1], "1:0")

    def test_macos_can_omit_rigid_rate_and_size(self) -> None:
        with patch("platform.system", return_value="Darwin"):
            args = build_device_webcam_input_args(framerate=None, video_size=None)
        self.assertEqual(args[0:2], ["-f", "avfoundation"])
        self.assertNotIn("-framerate", args)
        self.assertNotIn("-video_size", args)

    def test_macos_obs_1080p60_mode(self) -> None:
        with patch("platform.system", return_value="Darwin"):
            args = build_device_webcam_input_args(
                device_index=1, video_size="1920x1080", framerate="60"
            )
        self.assertEqual(args[args.index("-framerate") + 1], "60")
        self.assertEqual(args[args.index("-video_size") + 1], "1920x1080")
        self.assertTrue(args[args.index("-i") + 1].startswith("1:"))

    def test_linux_v4l2_plus_anullsrc(self) -> None:
        with patch("platform.system", return_value="Linux"), patch.dict(
            os.environ, {"LOCAL_WEBCAM_DEVICE": "/dev/video2"}, clear=False
        ):
            args = build_device_webcam_input_args(duration_sec=5)
        self.assertEqual(args[0:2], ["-f", "v4l2"])
        self.assertIn("/dev/video2", args)
        self.assertIn("anullsrc=channel_layout=stereo:sample_rate=48000", args)
        self.assertIn("-shortest", args)

    def test_build_ffmpeg_input_routes_webcam(self) -> None:
        with patch(
            "moq_publish.build_device_webcam_input_args",
            return_value=["-f", "avfoundation", "-i", "0:0"],
        ) as mock_webcam:
            out = build_ffmpeg_input_args("device:webcam", duration_sec=10)
        mock_webcam.assert_called_once_with(duration_sec=10, device_index=None)
        self.assertEqual(out, ["-f", "avfoundation", "-i", "0:0"])

    def test_device_index_parsing(self) -> None:
        self.assertIsNone(device_webcam_index("device:webcam"))
        self.assertEqual(device_webcam_index("device:webcam:0"), 0)
        self.assertEqual(device_webcam_index("device:webcam:2"), 2)
        self.assertEqual(device_webcam_index("DEVICE:WEBCAM:1"), 1)
        # Malformed suffixes fall back to the default device.
        self.assertIsNone(device_webcam_index("device:webcam:abc"))
        self.assertIsNone(device_webcam_index("device:webcam:-1"))
        self.assertIsNone(device_webcam_index("dummy.mp4"))

    def test_macos_device_index_overrides_env(self) -> None:
        with patch("platform.system", return_value="Darwin"), patch.dict(
            os.environ, {"LOCAL_WEBCAM_AVFOUNDATION": "0:1"}, clear=False
        ):
            args = build_device_webcam_input_args(duration_sec=8, device_index=2)
        # Picker video index wins; configured audio input is preserved.
        self.assertEqual(args[args.index("-i") + 1], "2:1")

    def test_linux_device_index_overrides_env(self) -> None:
        with patch("platform.system", return_value="Linux"), patch.dict(
            os.environ, {"LOCAL_WEBCAM_DEVICE": "/dev/video0"}, clear=False
        ):
            args = build_device_webcam_input_args(duration_sec=5, device_index=3)
        self.assertIn("/dev/video3", args)
        self.assertNotIn("/dev/video0", args)

    def test_build_ffmpeg_input_passes_index(self) -> None:
        with patch(
            "moq_publish.build_device_webcam_input_args",
            return_value=["-f", "avfoundation", "-i", "1:0"],
        ) as mock_webcam:
            build_ffmpeg_input_args("device:webcam:1", duration_sec=10)
        mock_webcam.assert_called_once_with(duration_sec=10, device_index=1)


class WebcamEnumerationTests(unittest.TestCase):
    """Agent-side camera discovery advertised in the hello capabilities."""

    AVFOUNDATION_STDERR = "\n".join(
        [
            "[AVFoundation indev @ 0x7fb1] AVFoundation video devices:",
            "[AVFoundation indev @ 0x7fb1] [0] FaceTime HD Camera",
            "[AVFoundation indev @ 0x7fb1] [1] Logitech BRIO",
            "[AVFoundation indev @ 0x7fb1] [2] Capture screen 0",
            "[AVFoundation indev @ 0x7fb1] AVFoundation audio devices:",
            "[AVFoundation indev @ 0x7fb1] [0] MacBook Pro Microphone",
            ": Input/output error",
        ]
    )

    def test_macos_parses_video_devices_and_skips_screens(self) -> None:
        from publisher_agent.deps import list_webcam_devices

        completed = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr=self.AVFOUNDATION_STDERR
        )
        with patch("platform.system", return_value="Darwin"), patch(
            "subprocess.run", return_value=completed
        ):
            devices = list_webcam_devices("/usr/bin/ffmpeg")
        self.assertEqual(
            devices,
            [
                {"index": 0, "name": "FaceTime HD Camera"},
                {"index": 1, "name": "Logitech BRIO"},
            ],
        )

    def test_unknown_platform_returns_empty(self) -> None:
        from publisher_agent.deps import list_webcam_devices

        with patch("platform.system", return_value="Windows"):
            self.assertEqual(list_webcam_devices(""), [])


if __name__ == "__main__":
    unittest.main()
