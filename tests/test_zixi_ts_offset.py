"""Unit tests for Zixi Fast HLS output_ts_offset allocator."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from zixi_ts_offset import (  # noqa: E402
    allocate_output_ts_offset,
    ffmpeg_output_ts_offset_args,
    reset_output_ts_offset,
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


if __name__ == "__main__":
    unittest.main()
