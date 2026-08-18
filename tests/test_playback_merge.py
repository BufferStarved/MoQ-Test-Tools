"""Playback-sample persistence: merge must be nearest-at-or-before, not exact.

Regression for the metrics audit finding that exact elapsed_sec equality plus
a ~6s elapsed-base mismatch (browser counted from started_at_epoch, upload
samples from pipeline start) left every persisted playback_*/e2e_latency_ms
column at 0.
"""

import csv
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from metrics import CSV_COLUMNS  # noqa: E402
from playback_metrics import merge_playback_into_csv, robust_e2e_stats  # noqa: E402


def _write_csv(path: str, count: int, base_ts: float = 1000.0) -> None:
    with open(path, mode="w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for second in range(count):
            row = {name: "0" for name in CSV_COLUMNS}
            row["timestamp"] = str(base_ts + second)
            writer.writerow(row)


class PlaybackMergeTests(unittest.TestCase):
    def test_offset_playback_samples_still_merge(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=10)
            # Playback ticks land between row seconds (e.g. 2.4 → floor 2) and
            # skip some seconds entirely.
            playback = [
                {"elapsed_sec": 2, "e2e_latency_ms": 1200, "playback_buffer_sec": 0.6},
                {"elapsed_sec": 5, "e2e_latency_ms": 1400, "playback_buffer_sec": 0.9},
            ]
            rows = merge_playback_into_csv(csv_path, playback, csv_columns=CSV_COLUMNS)

        self.assertEqual(len(rows), 10)
        # Before the first playback sample: defaults.
        self.assertEqual(rows[1]["e2e_latency_ms"], "0")
        # At and after each playback tick, values forward-fill.
        self.assertEqual(rows[2]["e2e_latency_ms"], "1200")
        self.assertEqual(rows[3]["e2e_latency_ms"], "1200")  # gap second: carry
        self.assertEqual(rows[4]["e2e_latency_ms"], "1200")
        self.assertEqual(rows[5]["e2e_latency_ms"], "1400")
        self.assertEqual(rows[9]["e2e_latency_ms"], "1400")
        self.assertEqual(rows[9]["playback_buffer_sec"], "0.9")

    def test_playback_sample_between_rows_attaches_backward(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            # Rows at elapsed 0,1,2,3,4 but playback arrives at elapsed 3 only.
            _write_csv(csv_path, count=5)
            playback = [{"elapsed_sec": 3, "e2e_latency_ms": 900}]
            rows = merge_playback_into_csv(csv_path, playback, csv_columns=CSV_COLUMNS)

        self.assertEqual(rows[2]["e2e_latency_ms"], "0")
        self.assertEqual(rows[3]["e2e_latency_ms"], "900")
        self.assertEqual(rows[4]["e2e_latency_ms"], "900")


class RobustE2eTests(unittest.TestCase):
    def test_trims_freeze_runaway(self):
        stats = robust_e2e_stats([0, 2900, 3100, 3300, 16000, 17000])
        self.assertIsNotNone(stats)
        self.assertLess(stats["avg"], 4000)
        self.assertEqual(stats["max"], 3300)

    def test_rejects_media_timeline_as_unix_epoch(self):
        self.assertIsNone(robust_e2e_stats([0, 0, 3, 5]))


if __name__ == "__main__":
    unittest.main()
