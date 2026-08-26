"""Latency decomposition + normalized frame accounting.

The point of splitting e2e into components is attribution, so these tests pin
the properties that make attribution trustworthy, each of which a live leg on
2026-08-22 proved was not holding:

* the encoder pipeline offset that ``encode_lag_ms`` hides reappears exactly
  once, and only where the leg's e2e estimator can actually see it;
* disagreement between the estimate and the parts is *signed* — over- and
  under-attribution are different facts and get different columns;
* a stage with no instrument is named, not reported as a confident zero;
* frame delivery is computed over a window both counters share.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from latency_budget import (  # noqa: E402
    BROKER_GOP_MS,
    E2E_SCOPE_CAPTURE_TO_GLASS,
    E2E_SCOPE_CAPTURE_TO_INGEST,
    E2E_SCOPE_INGEST_TO_GLASS,
    LATENCY_COMPONENTS,
    LL_HLS_PART_MS,
    _clean_ms,
    build_frame_row,
    build_latency_budget,
    e2e_scope_for,
    encode_frame_drop_pct,
    encode_latency_ms,
    frame_delivery_pct,
    network_latency_ms,
    playback_frame_drop_pct,
    player_buffer_latency_ms,
    resolve_segmentation_ms,
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


class SanityCeilingTests(unittest.TestCase):
    def test_a_value_past_the_ceiling_is_dropped_not_clamped_to_it(self):
        """The ceiling exists to keep artifacts out of the stack. Clamping put
        them *in* the stack wearing a confident 60000ms label — indistinguishable
        from a real minute-long stage."""
        self.assertEqual(_clean_ms(59_000), 59_000.0)
        self.assertEqual(_clean_ms(70_000), 0.0)
        self.assertEqual(player_buffer_latency_ms(playback_buffer_sec=99_999), 0.0)

    def test_measured_e2e_keeps_a_wider_ceiling_than_one_stage(self):
        """A broken leg genuinely reached 37.7s (job c49d2ef4) and a 90s leg
        must still chart; only an individual stage is implausible past 60s."""
        budget = build_latency_budget(e2e_latency_ms=90_000, packager_transit_ms=0)
        self.assertEqual(budget.e2e_ms, 90_000.0)
        self.assertEqual(build_latency_budget(e2e_latency_ms=200_000).e2e_ms, 0.0)


class ReconciliationTests(unittest.TestCase):
    def test_residual_exposes_unexplained_glass_delay(self):
        """Zixi Fast HLS chunk packaging is unmeasured — it must show up as
        unattributed *and named*, not folded into another component."""
        budget = build_latency_budget(
            pipeline_baseline_ms=1500,
            net_rtt_ms=60,
            playback_buffer_sec=4.0,
            e2e_latency_ms=12_000,
        )
        self.assertEqual(budget.accounted_ms, 1500 + 30 + 4000)
        self.assertEqual(budget.residual_ms, 12_000 - budget.accounted_ms)
        self.assertEqual(budget.overcount_ms, 0.0)
        self.assertEqual(budget.unmeasured_stages, ("segmentation", "publish", "packager"))

    def test_residual_is_zero_without_an_e2e_measurement(self):
        """No measured glass delay means nothing to attribute; a stack of
        components alone would imply a total we never measured."""
        budget = build_latency_budget(pipeline_baseline_ms=1500, e2e_latency_ms=0)
        self.assertEqual(budget.accounted_ms, 1500.0)
        self.assertEqual(budget.residual_ms, 0.0)
        self.assertEqual(budget.overcount_ms, 0.0)

    def test_over_attribution_is_reported_not_hidden_by_the_clamp(self):
        """A clamped residual made over-counting look like a clean
        reconciliation. The two are different facts and get different columns."""
        budget = build_latency_budget(
            pipeline_baseline_ms=5000,
            playback_buffer_sec=5.0,
            e2e_latency_ms=1000,
        )
        self.assertEqual(budget.residual_ms, 0.0)
        self.assertEqual(budget.overcount_ms, 9000.0)
        self.assertEqual(budget.as_row()["latency_overcount_ms"], "9000.0")

    def test_only_one_of_residual_and_overcount_can_be_nonzero(self):
        for e2e in (100, 1000, 9000, 20_000):
            budget = build_latency_budget(
                pipeline_baseline_ms=2000,
                playback_buffer_sec=3.0,
                e2e_latency_ms=e2e,
            )
            self.assertFalse(
                budget.residual_ms > 0 and budget.overcount_ms > 0,
                f"both non-zero at e2e={e2e}",
            )

    def test_unmeasured_is_not_the_same_as_measured_zero(self):
        """Zixi HTTP-TS really has no packaging buffer (a measured 0); Zixi Fast
        HLS has no PDT to measure it with at all. Reporting both as 0.0 is what
        let a named cost be charted as free."""
        measured = build_latency_budget(packager_transit_ms=0.0, e2e_latency_ms=500)
        self.assertNotIn("packager", measured.unmeasured_stages)
        unmeasured = build_latency_budget(packager_transit_ms=None, e2e_latency_ms=500)
        self.assertIn("packager", unmeasured.unmeasured_stages)
        self.assertEqual(unmeasured.as_row()["latency_packager_ms"], "0.0")

    def test_publish_stage_is_unmeasured_rather_than_a_startup_constant(self):
        """upload_latency_ms is a one-shot startup figure. Adding it to every
        steady-state sample inflated accounted_ms for a whole run (SRT local
        2026-08-22 over-attributed on 23 of 24 samples on a fixed 1998.9ms)."""
        budget = build_latency_budget(e2e_latency_ms=5000)
        self.assertEqual(budget.publish_ms, 0.0)
        self.assertIn("publish", budget.unmeasured_stages)


class E2eScopeTests(unittest.TestCase):
    def test_whep_e2e_is_not_charged_for_the_sender_pipeline(self):
        """Linode WebRTC 2026-08-22: 1419ms of components against a 35ms
        measured e2e, reported as a perfectly reconciled 0 residual. WHEP's
        estimate is ICE RTT/2 + jitter buffer — it never spanned the encoder."""
        common = dict(
            pipeline_baseline_ms=1400,
            net_rtt_ms=37,
            playback_buffer_sec=0.03,
            e2e_latency_ms=35,
        )
        wrong = build_latency_budget(**common, e2e_scope=E2E_SCOPE_CAPTURE_TO_GLASS)
        self.assertGreater(wrong.overcount_ms, 1300)

        budget = build_latency_budget(**common, e2e_scope=E2E_SCOPE_INGEST_TO_GLASS)
        # Still reported: the operator needs to know the sender pipeline exists.
        self.assertEqual(budget.encode_ms, 1400.0)
        # But not summed against an estimate that structurally cannot see it.
        self.assertEqual(budget.accounted_ms, 18.5 + 30.0)
        self.assertLess(budget.overcount_ms, 15.0)
        self.assertEqual(budget.as_row()["latency_e2e_scope"], "ingest_to_glass")

    def test_scope_follows_the_player_that_computes_e2e(self):
        self.assertEqual(e2e_scope_for("webrtc", "whep"), E2E_SCOPE_INGEST_TO_GLASS)
        self.assertEqual(e2e_scope_for("webrtc"), E2E_SCOPE_INGEST_TO_GLASS)
        # A WHIP publish watched through the LL-HLS remux really is
        # capture-to-glass; the wrong-path caveat is a separate concern.
        self.assertEqual(e2e_scope_for("webrtc", "hls"), E2E_SCOPE_CAPTURE_TO_GLASS)
        self.assertEqual(e2e_scope_for("moq", "moq"), E2E_SCOPE_CAPTURE_TO_GLASS)
        self.assertEqual(e2e_scope_for("srt", "hls"), E2E_SCOPE_CAPTURE_TO_GLASS)
        self.assertEqual(e2e_scope_for("moq", "moq", "upload"), E2E_SCOPE_CAPTURE_TO_INGEST)
        self.assertEqual(e2e_scope_for("srt", "monitor"), E2E_SCOPE_CAPTURE_TO_INGEST)

    def test_upload_scope_includes_segmentation_excludes_player_buffer(self):
        budget = build_latency_budget(
            pipeline_baseline_ms=400,
            encode_lag_ms=0,
            publish_transit_ms=80,
            net_rtt_ms=40,
            packager_transit_ms=25,
            playback_buffer_sec=2.0,
            e2e_latency_ms=0,
            e2e_scope=E2E_SCOPE_CAPTURE_TO_INGEST,
        )
        self.assertEqual(budget.e2e_scope, E2E_SCOPE_CAPTURE_TO_INGEST)
        self.assertGreater(budget.player_buffer_ms, 0)
        self.assertIn("latency_player_buffer_ms", budget.out_of_scope)
        self.assertAlmostEqual(
            budget.accounted_ms,
            budget.encode_ms
            + budget.segmentation_ms
            + budget.publish_ms
            + budget.network_ms
            + budget.packager_ms,
        )

    def test_row_has_every_component_column(self):
        row = build_latency_budget(pipeline_baseline_ms=100).as_row()
        for name in LATENCY_COMPONENTS:
            self.assertIn(name, row)
        for name in (
            "latency_accounted_ms",
            "latency_residual_ms",
            "latency_overcount_ms",
            "latency_unmeasured",
            "latency_e2e_scope",
        ):
            self.assertIn(name, row)
        self.assertIn("latency_not_applicable", row)


class SegmentationHopTests(unittest.TestCase):
    def test_moq_group_is_named_segmentation_not_ingest(self):
        budget = build_latency_budget(
            protocol="moq",
            segmentation_ms=500,
            split_gop_from_encode=True,
            pipeline_baseline_ms=1800,
            e2e_latency_ms=4000,
        )
        self.assertEqual(budget.segmentation_ms, 500.0)
        self.assertEqual(budget.encode_ms, 1300.0)
        self.assertNotIn("segmentation", budget.unmeasured_stages)
        self.assertNotIn("segmentation", budget.not_applicable_stages)
        self.assertIn("latency_segmentation_ms", budget.as_row())

    def test_unknown_gop_is_unmeasured_not_zero(self):
        budget = build_latency_budget(protocol="moq", e2e_latency_ms=4000)
        self.assertEqual(budget.segmentation_ms, 0.0)
        self.assertIn("segmentation", budget.unmeasured_stages)

    def test_webrtc_segmentation_is_not_applicable(self):
        budget = build_latency_budget(
            protocol="webrtc",
            e2e_scope=E2E_SCOPE_INGEST_TO_GLASS,
            e2e_latency_ms=35,
            net_rtt_ms=37,
            playback_buffer_sec=0.03,
        )
        self.assertIn("segmentation", budget.not_applicable_stages)
        self.assertNotIn("segmentation", budget.unmeasured_stages)
        self.assertEqual(budget.segmentation_ms, 0.0)
        self.assertNotIn("latency_segmentation_ms", budget.as_row()["latency_unmeasured"])

    def test_ll_hls_parts_are_200ms_not_a_1s_cmaf_group(self):
        ms, na = resolve_segmentation_ms(protocol="hls", playback_engine="ll-hls")
        self.assertFalse(na)
        self.assertEqual(ms, LL_HLS_PART_MS)
        self.assertNotEqual(ms, BROKER_GOP_MS)
        budget = build_latency_budget(protocol="hls", playback_engine="ll-hls", e2e_latency_ms=800)
        self.assertEqual(budget.segmentation_ms, 200.0)

    def test_file_source_moq_does_not_zero_encode_by_over_subtracting_gop(self):
        """File-source -re baseline is ~40ms; GOP is 1s. Subtracting GOP
        wiped latency_encode_ms on GCP MoQ f2ce8fe2 (0/28)."""
        self.assertEqual(
            encode_latency_ms(
                pipeline_baseline_ms=40,
                encode_lag_ms=0,
                segmentation_ms=1000,
                split_gop_from_encode=True,
            ),
            40.0,
        )
        # Fragment-close baselines that actually contain the GOP still split.
        self.assertEqual(
            encode_latency_ms(
                pipeline_baseline_ms=1800,
                encode_lag_ms=0,
                segmentation_ms=500,
                split_gop_from_encode=True,
            ),
            1300.0,
        )

    def test_srt_ll_hls_and_zixi_fast_hls_collect_segmentation(self):
        ms, na = resolve_segmentation_ms(protocol="srt", playback_engine="ll-hls")
        self.assertFalse(na)
        self.assertEqual(ms, LL_HLS_PART_MS)
        ms, na = resolve_segmentation_ms(protocol="rtmp", playback_engine="hls")
        self.assertFalse(na)
        self.assertEqual(ms, 2000.0)
        budget = build_latency_budget(
            protocol="rtmp", playback_engine="hls", e2e_latency_ms=4000
        )
        self.assertEqual(budget.segmentation_ms, 2000.0)
        self.assertNotIn("segmentation", budget.unmeasured_stages)
        self.assertNotIn("segmentation", budget.not_applicable_stages)

    def test_upload_scope_keeps_cmaf_segmentation(self):
        budget = build_latency_budget(
            protocol="moq",
            segmentation_ms=250,
            pipeline_baseline_ms=400,
            e2e_scope=E2E_SCOPE_CAPTURE_TO_INGEST,
            e2e_latency_ms=0,
        )
        self.assertEqual(budget.segmentation_ms, 250.0)
        self.assertIn("latency_player_buffer_ms", budget.out_of_scope)
        self.assertNotIn("latency_segmentation_ms", budget.out_of_scope)


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

    def test_delivery_needs_a_window_both_counters_share(self):
        """Raw cumulative totals measure when the browser attached, not
        delivery: every leg of the 2026-08-22 matrix read 3.6-10.1% with zero
        drops anywhere."""
        self.assertIsNone(
            frame_delivery_pct(encode_frames_total=1000, playback_frames_rendered=900)
        )
        # 300 encoded and 300 painted since attach = nothing lost, however far
        # apart the raw totals are.
        self.assertEqual(
            frame_delivery_pct(
                encode_frames_total=700,
                playback_frames_rendered=330,
                encode_frames_at_attach=400,
                playback_frames_at_attach=30,
            ),
            100.0,
        )
        self.assertEqual(
            frame_delivery_pct(
                encode_frames_total=700,
                playback_frames_rendered=180,
                encode_frames_at_attach=400,
                playback_frames_at_attach=30,
            ),
            50.0,
        )

    def test_a_frozen_player_reads_zero_not_a_decaying_ramp(self):
        """Linode Zixi RTMP: rendered froze at 84 while encoded climbed to 835.
        The old ratio decayed 48.0% -> 10.1% as if loss were ramping."""
        self.assertEqual(
            frame_delivery_pct(
                encode_frames_total=835,
                playback_frames_rendered=84,
                encode_frames_at_attach=300,
                playback_frames_at_attach=84,
            ),
            0.0,
        )

    def test_delivery_above_100_is_shown_not_clamped(self):
        """A player reading ahead of the encoder counter is clock skew or a
        mis-placed attach point; clamping it to a perfect 100% hid that."""
        pct = frame_delivery_pct(
            encode_frames_total=500,
            playback_frames_rendered=260,
            encode_frames_at_attach=400,
            playback_frames_at_attach=30,
        )
        self.assertIsNotNone(pct)
        self.assertGreater(pct, 100.0)

    def test_no_data_reports_blank_not_a_fake_percentage(self):
        self.assertIsNone(
            frame_delivery_pct(encode_frames_total=0, playback_frames_rendered=0)
        )
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
        # Blank, not "0.00": no shared window is unknown, not "nothing arrived".
        self.assertEqual(row["frame_delivery_pct"], "")


class CsvSchemaTests(unittest.TestCase):
    def test_every_new_column_is_persisted(self):
        for name in (
            *LATENCY_COMPONENTS,
            "latency_accounted_ms",
            "latency_residual_ms",
            "latency_overcount_ms",
            "latency_unmeasured",
            "latency_not_applicable",
            "latency_e2e_scope",
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
