"""EncodeLagTracker: encode lag must be startup-baseline-subtracted growth.

Regression for the metrics audit finding that raw (wall − out_time) re-added
a constant ~1.2–2.4s startup offset (process spawn + webcam-broker warmup)
into every per-second sample on the SRT LL-HLS and MoQ paths.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from metrics import EncodeLagTracker, compute_encode_lag_ms  # noqa: E402


class EncodeLagTrackerTests(unittest.TestCase):
    def test_zero_before_first_media(self):
        tracker = EncodeLagTracker()
        self.assertEqual(tracker.sample(0.0, "00:00:00.000000"), 0.0)
        self.assertEqual(tracker.sample(3.0, "00:00:00.000000"), 0.0)
        self.assertEqual(tracker.sample(3.0, "N/A"), 0.0)

    def test_startup_offset_is_baselined_out(self):
        tracker = EncodeLagTracker()
        # Encoder starts producing at wall t=6s (broker warmup): raw lag 5.0s.
        self.assertEqual(tracker.sample(6.0, "00:00:01.000000"), 0.0)
        # Keeping up with realtime: raw lag stays 5.0s → growth stays 0.
        self.assertEqual(tracker.sample(7.0, "00:00:02.000000"), 0.0)
        self.assertEqual(tracker.sample(16.0, "00:00:11.000000"), 0.0)

    def test_sustained_lag_growth_is_reported(self):
        tracker = EncodeLagTracker()
        tracker.sample(6.0, "00:00:01.000000")  # baseline 5.0s
        # Encoder falls 0.5s further behind.
        self.assertAlmostEqual(tracker.sample(8.0, "00:00:02.500000"), 500.0)
        # And 2s further behind.
        self.assertAlmostEqual(tracker.sample(10.0, "00:00:03.000000"), 2000.0)

    def test_catching_up_never_goes_negative(self):
        tracker = EncodeLagTracker()
        tracker.sample(6.0, "00:00:01.000000")  # baseline 5.0s
        # Encoder catches up past the baseline (e.g. burst after stall).
        self.assertEqual(tracker.sample(8.0, "00:00:04.000000"), 0.0)

    def test_raw_helper_unchanged_for_absolute_gap(self):
        self.assertAlmostEqual(compute_encode_lag_ms(6.0, "00:00:01.000000"), 5000.0)


if __name__ == "__main__":
    unittest.main()
