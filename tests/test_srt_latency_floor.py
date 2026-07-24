"""SRT latency floor and stability defaults."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from encode_profile import (  # noqa: E402
    SRT_MIN_TARGET_LATENCY_MS,
    clamp_srt_target_latency_ms,
    effective_srt_caller_latency_ms,
)


class SrtLatencyFloorTests(unittest.TestCase):
    def test_floor_at_two_seconds(self) -> None:
        self.assertEqual(clamp_srt_target_latency_ms(800), SRT_MIN_TARGET_LATENCY_MS)
        self.assertEqual(clamp_srt_target_latency_ms(4000), 4000)

    def test_mediamtx_caller_cap(self) -> None:
        self.assertEqual(effective_srt_caller_latency_ms(4000, mediamtx=True), 2000)
        self.assertEqual(effective_srt_caller_latency_ms(1500, mediamtx=True), 2000)


if __name__ == "__main__":
    unittest.main()
