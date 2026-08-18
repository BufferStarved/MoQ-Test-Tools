"""Encoder GOP / HLS live-sync stay on 2s chunks at the 5s target."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from encode_profile import (  # noqa: E402
    gop_frames_for_latency,
    hls_live_sync_duration_sec,
    hls_segment_sec,
)


class HlsSegmentSecTests(unittest.TestCase):
    def test_five_second_target_stays_on_two_second_chunks(self):
        # Must match Zixi hls_chunk_time=2 and JS encodeProfiles.hlsSegmentSec.
        # Math.round(2.5) is 3 in JS — floor keeps both sides on 2s.
        self.assertEqual(hls_segment_sec(5000), 2)
        self.assertEqual(gop_frames_for_latency(5000), 60)
        self.assertEqual(hls_live_sync_duration_sec(5000), 4.0)

    def test_four_second_target_is_two_second_chunks(self):
        self.assertEqual(hls_segment_sec(4000), 2)
        self.assertEqual(hls_live_sync_duration_sec(4000), 4.0)

    def test_six_second_target_grows_to_three(self):
        self.assertEqual(hls_segment_sec(6000), 3)
        self.assertEqual(hls_live_sync_duration_sec(6000), 6.0)


if __name__ == "__main__":
    unittest.main()
