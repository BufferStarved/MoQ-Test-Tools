"""Comparable MoQ vs WebRTC columns must exist on the persisted CSV.

Regression for comparison (11).csv (2026-08-18): MoQ e2e_latency_ms and
playback_error_count were present as headers but stayed 0/empty while WebRTC
filled the same names — the merge path must keep both families writable.
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from metrics import CSV_COLUMNS  # noqa: E402
from playback_metrics import PLAYBACK_FIELD_NAMES  # noqa: E402


COMPARABLE_COLUMNS = (
    "encode_lag_ms",
    "upload_latency_ms",
    "net_rtt_ms",
    "net_jitter_ms",
    "net_loss_pct",
    "net_retrans_pct",
    "encoded_bitrate_kbps",
    "playback_ttff_ms",
    "playback_stall_count",
    "playback_frames_rendered",
    "playback_bitrate_bps",
    "playback_video_time_sec",
    "playback_rebuffer_sec",
    "playback_error_count",
    "e2e_latency_ms",
)


class CsvComparableMetricsTests(unittest.TestCase):
    def test_shared_verdict_columns_are_on_the_csv(self):
        missing = [name for name in COMPARABLE_COLUMNS if name not in CSV_COLUMNS]
        self.assertEqual(missing, [])

    def test_playback_merge_includes_e2e_and_error_count(self):
        for name in ("e2e_latency_ms", "playback_error_count", "playback_video_time_sec"):
            self.assertIn(name, PLAYBACK_FIELD_NAMES)

    def test_playback_policy_is_on_the_csv(self):
        self.assertIn("playback_policy", CSV_COLUMNS)
        self.assertIn("playback_policy", PLAYBACK_FIELD_NAMES)

    def test_test_scope_is_on_the_csv(self):
        self.assertIn("test_scope", CSV_COLUMNS)


if __name__ == "__main__":
    unittest.main()
