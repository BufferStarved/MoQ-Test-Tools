"""AVFoundation mode parse/pick — OBS Virtual Camera is 1080p60 only."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from avfoundation_modes import (  # noqa: E402
    avfoundation_input_hints,
    parse_avfoundation_supported_modes,
    pick_avfoundation_mode,
)


OBS_251 = """
[avfoundation @ 0xb96c60000] Selected framerate (30.000000) is not supported by the device.
[avfoundation @ 0xb96c60000] Supported modes:
[avfoundation @ 0xb96c60000]   1920x1080@[60.000000 60.000000]fps
[in#0 @ 0xb96c5c000] Error opening input: Input/output error
"""

MIXED = """
Supported modes:
  1280x720@[30.000000 30.000000]fps
  1920x1080@[30.000000 30.000000]fps
  1920x1080@[60.000000 60.000000]fps
  1080x1920@[30.000000 30.000000]fps
"""


class ParseModesTests(unittest.TestCase):
    def test_parses_obs_virtual_cam_1080p60(self) -> None:
        modes = parse_avfoundation_supported_modes(OBS_251)
        self.assertEqual(len(modes), 1)
        self.assertEqual(modes[0].size, "1920x1080")
        self.assertEqual(modes[0].native_fps, 60.0)
        self.assertFalse(modes[0].supports_fps(30))

    def test_empty_stderr(self) -> None:
        self.assertEqual(parse_avfoundation_supported_modes(""), [])


class PickModeTests(unittest.TestCase):
    def test_obs_only_mode_is_1080p60_not_720p30(self) -> None:
        modes = parse_avfoundation_supported_modes(OBS_251)
        picked = pick_avfoundation_mode(modes)
        self.assertIsNotNone(picked)
        assert picked is not None
        self.assertEqual(picked.size, "1920x1080")
        self.assertEqual(picked.native_fps, 60.0)
        size, fps = avfoundation_input_hints(picked)
        self.assertEqual(size, "1920x1080")
        self.assertEqual(fps, "60")

    def test_prefers_listed_720p30_when_available(self) -> None:
        modes = parse_avfoundation_supported_modes(MIXED)
        picked = pick_avfoundation_mode(modes)
        self.assertIsNotNone(picked)
        assert picked is not None
        self.assertEqual(picked.size, "1280x720")
        self.assertEqual(picked.native_fps, 30.0)

    def test_negotiate_omits_flags(self) -> None:
        self.assertEqual(avfoundation_input_hints(None, negotiate=True), (None, None))


if __name__ == "__main__":
    unittest.main()
