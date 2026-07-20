"""Unit tests for Zixi Fast HLS output_ts_offset allocator."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import json  # noqa: E402

from zixi_ts_offset import (  # noqa: E402
    allocate_output_ts_offset,
    ffmpeg_output_ts_offset_args,
    reset_output_ts_offset,
    stale_reset_seconds,
    step_seconds,
)


class ZixiTsOffsetTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.state_file = Path(self._tmpdir.name) / "offset.json"
        os.environ["ZIXI_TS_OFFSET_STATE"] = str(self.state_file)
        os.environ["ZIXI_OUTPUT_TS_OFFSET"] = "1"
        os.environ["ZIXI_TS_OFFSET_STEP_FLOOR"] = "300"

    def tearDown(self):
        self._tmpdir.cleanup()
        os.environ.pop("ZIXI_TS_OFFSET_STATE", None)
        os.environ.pop("ZIXI_OUTPUT_TS_OFFSET", None)
        os.environ.pop("ZIXI_TS_OFFSET_STEP_FLOOR", None)

    def test_step_uses_duration_or_floor(self):
        self.assertEqual(step_seconds(60), 300)
        self.assertEqual(step_seconds(400), 400)

    def test_monotonic_allocate(self):
        a = allocate_output_ts_offset("SRT Test", duration_sec=60)
        b = allocate_output_ts_offset("SRT Test", duration_sec=60)
        self.assertEqual(a, 0.0)
        self.assertEqual(b, 300.0)

    def test_reset_clears_counter(self):
        allocate_output_ts_offset("SRT Test", duration_sec=60)
        allocate_output_ts_offset("SRT Test", duration_sec=60)
        reset_output_ts_offset("SRT Test")
        again = allocate_output_ts_offset("SRT Test", duration_sec=60)
        self.assertEqual(again, 0.0)

    def test_disabled(self):
        os.environ["ZIXI_OUTPUT_TS_OFFSET"] = "0"
        self.assertEqual(allocate_output_ts_offset("SRT Test", duration_sec=60), 0.0)

    def test_ffmpeg_args(self):
        self.assertEqual(ffmpeg_output_ts_offset_args(0), [])
        self.assertEqual(ffmpeg_output_ts_offset_args(300), ["-output_ts_offset", "300"])

    def test_stale_stream_resets_instead_of_accumulating(self):
        """Regression: a live site reused across hundreds of runs must not walk
        the offset into the hours. A long idle gap means the Zixi packager has
        gone idle on its own, so the counter should restart at 0."""
        os.environ["ZIXI_TS_OFFSET_STALE_RESET_SEC"] = "60"
        self.assertEqual(stale_reset_seconds(), 60)

        allocate_output_ts_offset("SRT Test", duration_sec=60)
        third = allocate_output_ts_offset("SRT Test", duration_sec=60)
        self.assertEqual(third, 300.0)

        # Simulate the stream going idle for longer than the threshold by
        # backdating the persisted timestamp directly.
        data = json.loads(self.state_file.read_text())
        data["SRT Test"]["updated_at"] -= 120
        self.state_file.write_text(json.dumps(data))

        after_idle = allocate_output_ts_offset("SRT Test", duration_sec=60)
        self.assertEqual(after_idle, 0.0, "offset must restart after a long idle gap")

    def test_legacy_bare_int_state_still_loads(self):
        """Older deployments persisted a bare int per stream id (no timestamp)."""
        self.state_file.write_text(json.dumps({"SRT Test": 2}))
        offset = allocate_output_ts_offset("SRT Test", duration_sec=60)
        self.assertEqual(offset, 600.0)

    def test_active_stream_keeps_accumulating_without_stale_gap(self):
        os.environ["ZIXI_TS_OFFSET_STALE_RESET_SEC"] = "3600"
        a = allocate_output_ts_offset("SRT Test", duration_sec=60)
        b = allocate_output_ts_offset("SRT Test", duration_sec=60)
        c = allocate_output_ts_offset("SRT Test", duration_sec=60)
        self.assertEqual([a, b, c], [0.0, 300.0, 600.0])


if __name__ == "__main__":
    unittest.main()
