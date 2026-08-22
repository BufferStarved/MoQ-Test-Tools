"""Latency decomposition + normalized frame accounting.

The point of splitting e2e into components is attribution, so the tests here
pin the two properties that make attribution trustworthy: the encoder pipeline
offset that encode_lag_ms hides must reappear exactly once, and the residual
must expose disagreement between the estimate and the parts instead of
absorbing it silently.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from latency_budget import (  # noqa: E402
    LATENCY_COMPONENTS,
    build_frame_row,
    build_latency_budget,
    encode_frame_drop_pct,
    encode_latency_ms,
    frame_delivery_pct,
    network_latency_ms,
    playback_frame_drop_pct,
    player_buffer_latency_ms,
)
from metrics import CSV_COLUMNS, EncodeLagTracker  # noqa: E402


class EncodeComponentTests(unittest.TestCase):
    def test_pipeline_baseline_is_added_back_once(self):
        """encode_lag_ms charts only growth past the startup offset; the offset
        is still real glass delay and must land in the budget exactly once."""
        tracker = EncodeLagTracker()
        # Wall 3s / media 1s => 2s constant pipeline offset, reported as 0 lag.
        self.assertEqual(tracker.sample(3.0, "00:00:01.000000"), 0.0)
        self.assertEqual(tracker.pipeline_baseline_ms, 2000.0)
        # A later sample 500ms further behind is 500ms of *sustained* lag.
        lag = tracker.sample(6.5, "00:00:04.000000")
        self.assertEqual(lag, 500.0)
        self.assertEqual(
            encode_latency_ms(
                pipeline_baseline_ms=tracker.pipeline_baseline_ms,
                encode_lag_ms=lag,
            ),
            2500.0,
        )

    def test_no_baseline_yet_is_not_negative(self):
        self.assertEqual(encode_latency_ms(pipeline_baseline_ms=None, encode_lag_ms=None), 0.0)
        self.assertEqual(encode_latency_ms(pipeline_baseline_ms=-5, encode_lag_ms=-5), 0.0)


class NormalizedComponentTests(unittest.TestCase):
    def test_network_component_is_one_way(self):
        self.assertEqual(network_latency_ms(net_rtt_ms=80.0), 40.0)
        self.assertEqual(network_latency_ms(net_rtt_ms=0.0), 0.0)

    def test_player_buffer_converts_seconds(self):
        self.assertEqual(player_buffer_latency_ms(playback_buffer_sec=4.0), 4000.0)
        self.assertEqual(player_buffer_latency_ms(playback_buffer_sec=None), 0.0)

    def test_absurd_component_is_dropped_not_charted(self):
        # A clock artifact must not poison the stack.
        self.assertEqual(player_buffer_latency_ms(playback_buffer_sec=99_999), 60_000.0)


class ResidualTests(unittest.TestCase):
    def test_residual_exposes_unexplained_glass_delay(self):
        """Zixi Fast HLS chunk packaging is unmeasured — it must show up as
        unattributed rather than being folded into another component."""
        budget = build_latency_budget(
            pipeline_baseline_ms=1500,
            encode_lag_ms=0,
            upload_latency_ms=200,
            net_rtt_ms=60,
            packager_transit_ms=0,
            playback_buffer_sec=4.0,
            e2e_latency_ms=12_000,
        )
        self.assertEqual(budget.accounted_ms, 1500 + 200 + 30 + 0 + 4000)
        self.assertEqual(budget.residual_ms, 12_000 - budget.accounted_ms)

    def test_residual_is_zero_without_an_e2e_measurement(self):
        """No measured glass delay means nothing to attribute; a stack of
        components alone would imply a total we never measured."""
        budget = build_latency_budget(pipeline_baseline_ms=1500, e2e_latency_ms=0)
        self.assertEqual(budget.accounted_ms, 1500.0)
        self.assertEqual(budget.residual_ms, 0.0)

    def test_over_counting_clamps_instead_of_going_negative(self):
        budget = build_latency_budget(
            pipeline_baseline_ms=5000,
            playback_buffer_sec=5.0,
            e2e_latency_ms=1000,
        )
        self.assertEqual(budget.residual_ms, 0.0)

    def test_row_has_every_component_column(self):
        row = build_latency_budget(pipeline_baseline_ms=100).as_row()
        for name in LATENCY_COMPONENTS:
            self.assertIn(name, row)
        self.assertIn("latency_accounted_ms", row)
        self.assertIn("latency_residual_ms", row)


class FrameAccountingTests(unittest.TestCase):
    def test_encode_drop_pct_uses_frames_offered_not_expected_fps(self):
        """A genuine 24fps source is not dropping 20% of a 30fps expectation."""
        self.assertEqual(encode_frame_drop_pct(frames_total=720, frames_dropped=0), 0.0)
        self.assertEqual(encode_frame_drop_pct(frames_total=90, frames_dropped=10), 10.0)

    def test_playback_and_encode_share_a_denominator_convention(self):
        # Same 10-in-100 loss reads as the same percentage on both sides.
        self.assertEqual(
            encode_frame_drop_pct(frames_total=90, frames_dropped=10),
            playback_frame_drop_pct(frames_rendered=90, frames_dropped=10),
        )

    def test_frame_delivery_catches_midchain_loss(self):
        """Neither endpoint counter sees a relay/packager drop; the ratio does."""
        self.assertEqual(
            frame_delivery_pct(encode_frames_total=1000, playback_frames_rendered=900),
            90.0,
        )
        # Player marginally ahead within one sample interval is not >100%.
        self.assertEqual(
            frame_delivery_pct(encode_frames_total=900, playback_frames_rendered=905),
            100.0,
        )

    def test_no_data_reports_zero_not_a_fake_percentage(self):
        self.assertEqual(frame_delivery_pct(encode_frames_total=0, playback_frames_rendered=0), 0.0)
        self.assertEqual(playback_frame_drop_pct(frames_rendered=0, frames_dropped=0), 0.0)

    def test_frame_row_columns_exist(self):
        row = build_frame_row(
            encode_frames_total=100,
            encode_frames_dropped=5,
            encode_frames_duped=2,
            playback_frames_rendered=90,
            playback_frames_dropped=3,
        )
        self.assertEqual(row["encode_frames_duped"], "2")
        self.assertEqual(float(row["encode_frame_drop_pct"]), 4.762)


class CsvSchemaTests(unittest.TestCase):
    def test_every_new_column_is_persisted(self):
        for name in (
            *LATENCY_COMPONENTS,
            "latency_accounted_ms",
            "latency_residual_ms",
            "encode_frames_total",
            "encode_frames_dropped",
            "encode_frames_duped",
            "encode_frame_drop_pct",
            "playback_frame_drop_pct",
            "frame_delivery_pct",
        ):
            self.assertIn(name, CSV_COLUMNS)


if __name__ == "__main__":
    unittest.main()
