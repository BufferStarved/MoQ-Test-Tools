"""Local publisher webcam / live media input helpers."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moq_publish import (  # noqa: E402
    DEVICE_WEBCAM_MEDIA,
    build_device_webcam_input_args,
    build_ffmpeg_input_args,
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
        mock_webcam.assert_called_once_with(duration_sec=10)
        self.assertEqual(out, ["-f", "avfoundation", "-i", "0:0"])


if __name__ == "__main__":
    unittest.main()
