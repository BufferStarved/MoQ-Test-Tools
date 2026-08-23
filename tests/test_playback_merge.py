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
        # Before the player attached there is no measurement — blank, not a 0
        # that reads as "measured, and it was instant".
        self.assertEqual(rows[1]["e2e_latency_ms"], "")
        # At and after each playback tick, values carry across gap seconds.
        self.assertEqual(rows[2]["e2e_latency_ms"], "1200")
        self.assertEqual(rows[3]["e2e_latency_ms"], "1200")  # gap second: carry
        self.assertEqual(rows[4]["e2e_latency_ms"], "1200")
        self.assertEqual(rows[5]["e2e_latency_ms"], "1400")
        # ...but only while the carry is plausibly still live. Row 9 is 4s past
        # the last playback tick, so the player has stopped reporting.
        self.assertEqual(rows[9]["e2e_latency_ms"], "")
        self.assertEqual(rows[9]["playback_buffer_sec"], "")
        self.assertEqual(rows[8]["e2e_latency_ms"], "1400")

    def test_stale_playback_is_distinguishable_from_steady_playback(self):
        """Forward-filling past the player's last report made a detached leg
        look rock-steady: Linode WebRTC repeated one e2e for 22 of 30 samples,
        Zixi RTMP for 24 of 30, and both means were built out of that repeat."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=12)
            playback = [
                {"elapsed_sec": second, "e2e_latency_ms": 1000 + second}
                for second in range(4)
            ]
            rows = merge_playback_into_csv(csv_path, playback, csv_columns=CSV_COLUMNS)

        self.assertEqual(rows[3]["e2e_latency_ms"], "1003")
        self.assertEqual(rows[3]["playback_sample_age_sec"], "0")
        # Within the grace window a carry is still a plausible reading.
        self.assertEqual(rows[6]["e2e_latency_ms"], "1003")
        self.assertEqual(rows[6]["playback_sample_age_sec"], "3")
        # Past it, the column says "not being measured" instead of repeating.
        self.assertEqual(rows[7]["e2e_latency_ms"], "")
        self.assertEqual(rows[7]["playback_sample_age_sec"], "4")
        self.assertEqual(rows[11]["e2e_latency_ms"], "")
        # Cumulative run totals are still true statements and are not blanked.
        self.assertNotEqual(rows[11]["playback_frames_rendered"], "")

        from playback_metrics import compute_playback_averages

        averages = compute_playback_averages(rows)
        # The mean is over what was actually measured, not padded out by a
        # repeat of the last live reading.
        self.assertEqual(averages["e2e_latency_samples"], 7)
        self.assertLess(averages["e2e_latency_ms"], 1004)

    def test_playback_sample_between_rows_attaches_backward(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            # Rows at elapsed 0,1,2,3,4 but playback arrives at elapsed 3 only.
            _write_csv(csv_path, count=5)
            playback = [{"elapsed_sec": 3, "e2e_latency_ms": 900}]
            rows = merge_playback_into_csv(csv_path, playback, csv_columns=CSV_COLUMNS)

        self.assertEqual(rows[2]["e2e_latency_ms"], "")
        self.assertEqual(rows[3]["e2e_latency_ms"], "900")
        self.assertEqual(rows[4]["e2e_latency_ms"], "900")

    def test_error_count_and_e2e_forward_fill_together(self):
        """A mid-clip stall must persist both e2e and playback_error_count."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=8)
            playback = [
                {
                    "elapsed_sec": 2,
                    "e2e_latency_ms": 556,
                    "playback_error_count": 0,
                    "playback_video_time_sec": 1.5,
                },
                {
                    "elapsed_sec": 5,
                    "e2e_latency_ms": 8126,
                    "playback_error_count": 1,
                    "playback_video_time_sec": 12.43,
                },
            ]
            rows = merge_playback_into_csv(csv_path, playback, csv_columns=CSV_COLUMNS)

        self.assertEqual(rows[2]["e2e_latency_ms"], "556")
        self.assertEqual(rows[2]["playback_error_count"], "0")
        self.assertEqual(rows[5]["e2e_latency_ms"], "8126")
        self.assertEqual(rows[5]["playback_error_count"], "1")
        self.assertEqual(rows[7]["playback_error_count"], "1")
        self.assertEqual(rows[7]["playback_video_time_sec"], "12.43")

    def test_zero_reconnect_sample_does_not_erase_painted_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=6)
            playback = [
                {
                    "elapsed_sec": 3,
                    "playback_frames_rendered": 1692,
                    "playback_video_time_sec": 56.2,
                    "e2e_latency_ms": 800,
                },
                {
                    "elapsed_sec": 5,
                    "playback_frames_rendered": 0,
                    "playback_video_time_sec": 0,
                    "e2e_latency_ms": 0,
                },
            ]
            rows = merge_playback_into_csv(csv_path, playback, csv_columns=CSV_COLUMNS)

        self.assertEqual(rows[3]["playback_frames_rendered"], "1692")
        self.assertEqual(rows[5]["playback_frames_rendered"], "1692")
        self.assertEqual(rows[5]["e2e_latency_ms"], "800")
        from playback_metrics import compute_playback_averages

        averages = compute_playback_averages(rows)
        self.assertEqual(averages["playback_frames_rendered"], 1692)


class MergedLatencyBudgetTests(unittest.TestCase):
    """The persisted budget is recomputed here against merged playback values,
    so the merge is where the player-side stages get their final meaning."""

    def test_moq_behind_live_never_becomes_a_player_buffer(self):
        """MoQ LOC's playback_buffer_sec means the OPPOSITE of every other
        engine's — seconds the glass is behind live, not seconds queued ahead.
        Summing it charted a 10.9s "buffer" on the Linode MoQ leg
        (2026-08-22), on the protocol that should have been lowest-latency."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            _write_csv(csv_path, count=4)
            playback = [
                {
                    "elapsed_sec": 1,
                    "e2e_latency_ms": 400,
                    # LOC canvas: no HTML media buffer at all.
                    "playback_buffer_sec": 0,
                    "playback_behind_live_sec": 10.9,
                    "playback_frames_rendered": 30,
                }
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="moq"
            )

        self.assertEqual(rows[1]["playback_behind_live_sec"], "10.9")
        self.assertEqual(rows[1]["latency_player_buffer_ms"], "0.0")
        self.assertNotIn("10900", rows[1]["latency_accounted_ms"])

    def test_whep_leg_does_not_over_attribute_the_sender_pipeline(self):
        """Linode WebRTC: components averaged 1419ms against a 35ms measured
        e2e and the residual still reported 0.0."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            with open(csv_path, mode="w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
                writer.writeheader()
                for second in range(3):
                    row = {name: "0" for name in CSV_COLUMNS}
                    row["timestamp"] = str(1000.0 + second)
                    row["protocol"] = "webrtc"
                    row["latency_encode_ms"] = "1400.0"
                    row["latency_network_ms"] = "18.5"
                    row["latency_accounted_ms"] = "1418.5"
                    row["latency_unmeasured"] = "publish,packager"
                    writer.writerow(row)
            playback = [
                {"elapsed_sec": 1, "e2e_latency_ms": 35, "playback_buffer_sec": 0.03}
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="whep"
            )

        row = rows[1]
        self.assertEqual(row["latency_e2e_scope"], "ingest_to_glass")
        # The sender pipeline is still visible...
        self.assertEqual(row["latency_encode_ms"], "1400.0")
        # ...but is not summed against a receiver-side estimate.
        self.assertEqual(row["latency_accounted_ms"], "48.5")
        self.assertLess(float(row["latency_overcount_ms"]), 20.0)

    def test_frame_delivery_uses_the_window_the_player_was_attached_for(self):
        """Both counters are cumulative from different zero points; the raw
        ratio measured the attach offset and read ~4-10% with nothing lost."""
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            with open(csv_path, mode="w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
                writer.writeheader()
                for second in range(6):
                    row = {name: "0" for name in CSV_COLUMNS}
                    row["timestamp"] = str(1000.0 + second)
                    row["protocol"] = "rtmp"
                    # Encoder is already 300 frames in when the player attaches
                    # and keeps counting 30/s.
                    row["encode_frames_total"] = str(300 + second * 30)
                    row["latency_accounted_ms"] = "0.0"
                    writer.writerow(row)
            playback = [
                {"elapsed_sec": second, "playback_frames_rendered": (second - 1) * 30}
                for second in range(1, 6)
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        # Attach row: no window yet, so unknown rather than a fake percentage.
        self.assertEqual(rows[1]["frame_delivery_pct"], "")
        # Every encoded frame since attach was painted, even though the raw
        # totals (390 encoded vs 60 rendered) would have read 15%.
        self.assertEqual(rows[3]["frame_delivery_pct"], "100.00")
        self.assertEqual(rows[5]["frame_delivery_pct"], "100.00")

    def test_a_frozen_player_reads_zero_delivery_then_stops_reporting(self):
        """A stalled glass must be visible; a silent player must not fake one.

        Linode Zixi RTMP decayed 48.0% -> 10.1% while rendered froze at 84 and
        encoded climbed to 835, with nothing actually lost. After the attach
        windowing fix it still slid 100.00 -> 40.00 across the staleness grace
        window for the same reason at a smaller scale.
        """
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            with open(csv_path, mode="w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
                writer.writeheader()
                for second in range(8):
                    row = {name: "0" for name in CSV_COLUMNS}
                    row["timestamp"] = str(1000.0 + second)
                    row["protocol"] = "rtmp"
                    row["encode_frames_total"] = str(100 + second * 30)
                    row["latency_accounted_ms"] = "0.0"
                    writer.writerow(row)
            # Player paints 84 frames by second 2 and then freezes: it keeps
            # reporting the same total through second 3, then detaches.
            playback = [
                {"elapsed_sec": 1, "playback_frames_rendered": 54},
                {"elapsed_sec": 2, "playback_frames_rendered": 84},
                {"elapsed_sec": 3, "playback_frames_rendered": 84},
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        # Two different freezes, and only one of them is evidence.
        #
        # Row 2: the player reported 84 against 160 encoded — every frame since
        # attach painted, 100%.
        self.assertEqual(rows[2]["frame_delivery_pct"], "100.00")
        # Row 3: the player reported *again* and the counter had not moved. That
        # is a fresh observation of a stalled glass, so the ratio must fall:
        # 30 painted of the 60 encoded since attach.
        self.assertEqual(rows[3]["frame_delivery_pct"], "50.00")
        # Rows 4-6: no new playback sample at all — the 84 is forward-filled
        # while the encoder climbs to 220, 250, 280. Dividing a frozen numerator
        # by a live denominator invented the old 33.33 -> 25.00 -> 20.00 slide,
        # which is the same shape as real loss and was none. Pinning the encoder
        # total to the last report holds the last real measurement instead.
        self.assertEqual(rows[4]["frame_delivery_pct"], "50.00")
        self.assertEqual(rows[5]["frame_delivery_pct"], "50.00")
        self.assertEqual(rows[6]["frame_delivery_pct"], "50.00")
        # Detached past the grace window: no longer measurable, so no number.
        self.assertEqual(rows[7]["frame_delivery_pct"], "")

    def test_the_2026_08_23_rtmp_grace_window_slide_does_not_return(self):
        """Replay of the trace that kept the RTMP leg failing after the fix.

        Audited samples 7-11 of upload_20260823-014026_f37981b8: the encoder
        climbs 175 -> 295 at 30/s, the player is parked at 73 rendered and has
        stopped sending samples (age 0,1,2,3,4), and delivery read
        100.00 -> 66.67 -> 50.00 -> 40.00 before blanking. Nothing was lost;
        the whole slide was the forward-filled numerator.
        """
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            with open(csv_path, mode="w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
                writer.writeheader()
                for second, encoded in enumerate([145, 175, 205, 235, 265, 295]):
                    row = {name: "0" for name in CSV_COLUMNS}
                    row["timestamp"] = str(1000.0 + second)
                    row["protocol"] = "rtmp"
                    row["encode_frames_total"] = str(encoded)
                    row["latency_accounted_ms"] = "0.0"
                    writer.writerow(row)
            # The player reports twice and then goes quiet for the rest of the
            # leg, exactly as it did on the real run.
            playback = [
                {"elapsed_sec": 0, "playback_frames_rendered": 43},
                {"elapsed_sec": 1, "playback_frames_rendered": 73},
            ]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="mpegts"
            )

        self.assertEqual(rows[1]["frame_delivery_pct"], "100.00")
        # Ages 1, 2, 3 — the grace window. Previously 66.67, 50.00, 40.00.
        for index in (2, 3, 4):
            self.assertEqual(
                rows[index]["frame_delivery_pct"],
                "100.00",
                msg=f"row {index} (age {index - 1}) slid instead of holding",
            )
        self.assertEqual(rows[5]["frame_delivery_pct"], "")

    def test_unmeasured_stages_survive_into_the_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = str(Path(tmp) / "run.csv")
            with open(csv_path, mode="w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
                writer.writeheader()
                for second in range(3):
                    row = {name: "0" for name in CSV_COLUMNS}
                    row["timestamp"] = str(1000.0 + second)
                    row["protocol"] = "srt"
                    row["latency_accounted_ms"] = "0.0"
                    # Zixi: no PDT to derive packaging from, no publish probe.
                    row["latency_unmeasured"] = "publish,packager"
                    writer.writerow(row)
            playback = [{"elapsed_sec": 1, "e2e_latency_ms": 8117}]
            rows = merge_playback_into_csv(
                csv_path, playback, csv_columns=CSV_COLUMNS, playback_engine="hls"
            )

        from playback_metrics import compute_playback_averages

        self.assertEqual(rows[1]["latency_unmeasured"], "publish,packager")
        self.assertGreater(float(rows[1]["latency_residual_ms"]), 8000)
        averages = compute_playback_averages(rows)
        self.assertEqual(averages["latency_unmeasured_stages"], "packager,publish")


class RobustE2eTests(unittest.TestCase):
    def test_trims_freeze_runaway_from_the_average_only(self):
        """The average ignores freeze spikes so one stall does not dominate the
        headline number, but "max" must stay the worst glass delay actually
        observed — a trimmed max understates exactly the legs that need
        attention."""
        stats = robust_e2e_stats([0, 2900, 3100, 3300, 16000, 17000])
        self.assertIsNotNone(stats)
        self.assertLess(stats["avg"], 4000)
        self.assertEqual(stats["max"], 17000)

    def test_rejects_media_timeline_as_unix_epoch(self):
        self.assertIsNone(robust_e2e_stats([0, 0, 3, 5]))

    def test_ceiling_matches_the_frontend_so_broken_legs_still_report(self):
        """A 30s ceiling discarded every sample from job c49d2ef4 (WebRTC,
        ~37s glass delay), so its summary read as "not measured" rather than
        "worst leg in the run"."""
        from playback_metrics import E2E_MAX_MS

        self.assertEqual(E2E_MAX_MS, 180_000.0)
        stats = robust_e2e_stats([31_000, 34_000, 37_000])
        self.assertIsNotNone(stats)
        self.assertEqual(stats["max"], 37_000)


if __name__ == "__main__":
    unittest.main()
