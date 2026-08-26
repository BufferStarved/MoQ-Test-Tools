"""The audit's verdict must mean "a metric is lying", not "a number is large".

``qa_metric_audit.py --assert`` is the acceptance gate for a matrix run, so a
failure it reports has to be actionable as a metric bug. Two of its rules reach
the opposite conclusion — that the value is large *and* the metric is honest —
and used to fail the leg anyway. These tests pin the split, and pin the MoQ
buffer rule to the evidence in the CSV rather than to an assumption about which
MoQ player was used.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from typing import List, Optional

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "qa_metric_audit.py"


def _load_audit():
    spec = importlib.util.spec_from_file_location("qa_metric_audit", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _rows(
    *,
    protocol: str,
    samples: int = 10,
    fps: float = 30.0,
    fps_stability: float = 0.01,
    buffer_ms: float = 0.0,
    behind_live: Optional[float] = 0.0,
    cmaf: bool = False,
) -> List[dict]:
    """A leg whose only interesting property is the one under test.

    The frame counter advances at exactly 30/s so ``fps_truth`` derives 30.0,
    letting the ``fps`` argument set the rate-column mean independently — that
    difference is what the 8b rules read.
    """
    out = []
    for i in range(samples):
        out.append(
            {
                "protocol": protocol,
                "timestamp": f"{float(i)}",
                "encode_frames_total": f"{30 * (i + 1)}",
                "fps": f"{fps}",
                "fps_stability": f"{fps_stability}",
                # Only the tail carries the player's report, as on a real leg
                # where the browser attaches after the encoder.
                "latency_player_buffer_ms": f"{buffer_ms}" if i >= samples - 3 else "0",
                "playback_behind_live_sec": (
                    "" if behind_live is None else (f"{behind_live}" if i >= samples - 3 else "0")
                ),
                "cmaf_fragment_count": f"{2 * (i + 1)}" if cmaf else "0",
            }
        )
    return out


class MoqBufferRuleTests(unittest.TestCase):
    """A deep buffer on MoQ is only a leak when behind-live is what filled it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.audit = _load_audit()

    def test_the_cmaf_leg_that_was_failed_for_a_leak_that_was_not_there(self) -> None:
        """Replays upload_20260823-023743_3121655a.

        7134ms in the buffer stage, ``playback_behind_live_sec`` 0.0 on every
        row, ``cmaf_fragment_count`` climbing 2 -> 59. The old rule read "MoQ"
        as "LOC canvas" and called this a behind-live leak, naming a cause the
        same CSV disproved.
        """
        rows = _rows(protocol="moq", buffer_ms=7134.2, behind_live=0.0, cmaf=True)
        failures, observations = self.audit.check_invariants(rows, "moq")

        self.assertFalse(
            [f for f in failures if "leak" in f],
            f"a CMAF leg with behind_live=0 must not be failed for leaking: {failures}",
        )
        self.assertTrue(
            [o for o in observations if "real buffered range" in o],
            f"the deep buffer should still be surfaced, as an observation: {observations}",
        )

    def test_an_actual_leak_still_fails(self) -> None:
        """Behind-live seconds sitting in the buffer stage is the real defect."""
        rows = _rows(protocol="moq", buffer_ms=7134.2, behind_live=7.1342, cmaf=False)
        failures, _ = self.audit.check_invariants(rows, "moq")

        self.assertTrue(
            [f for f in failures if "leaking into the buffer stage" in f],
            f"buffer stage carrying the behind-live value is a leak: {failures}",
        )

    def test_a_loc_canvas_cannot_explain_a_deep_buffer(self) -> None:
        """No MSE, no behind-live value: the number has no source, so it fails."""
        rows = _rows(protocol="moq", buffer_ms=7134.2, behind_live=None, cmaf=False)
        failures, _ = self.audit.check_invariants(rows, "moq")

        self.assertTrue(
            [f for f in failures if "no CMAF fragments" in f],
            f"an unexplained buffer on a LOC leg must fail: {failures}",
        )

    def test_a_shallow_buffer_says_nothing_either_way(self) -> None:
        rows = _rows(protocol="moq", buffer_ms=370.4, behind_live=0.0, cmaf=True)
        failures, observations = self.audit.check_invariants(rows, "moq")

        self.assertFalse([f for f in failures if "buffer" in f], failures)
        self.assertFalse([o for o in observations if "buffer" in o], observations)


class AbsenceGateTests(unittest.TestCase):
    """A column that never arrived must not read as compliance.

    Every other rule in the audit is "there is data and it is wrong", so before
    these gates a totally broken collector produced the same ``invariants OK``
    as a healthy leg — the false-pass vector left open by the 2026-08-23 round.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.audit = _load_audit()

    def _leg(self, protocol: str = "rtmp") -> List[dict]:
        rows = _rows(protocol=protocol)
        for row in rows:
            row["net_rtt_ms"] = "37.6"
            row["cpu_percent"] = "66.9"
            row["latency_encode_ms"] = "549.3"
            row["encoded_bitrate_kbps"] = "2981.1"
        return rows

    def test_a_healthy_leg_clears_the_absence_gate(self) -> None:
        failures, _ = self.audit.check_invariants(self._leg(), "rtmp")
        self.assertFalse(
            [f for f in failures if "collection failure" in f],
            f"a fully populated leg must not trip the absence gate: {failures}",
        )

    def test_a_silent_required_column_fails(self) -> None:
        rows = self._leg()
        for row in rows:
            row["net_rtt_ms"] = ""
        failures, _ = self.audit.check_invariants(rows, "rtmp")

        self.assertTrue(
            [f for f in failures if "net_rtt_ms" in f and "never emitted" in f],
            f"a collector that stopped reporting RTT must fail: {failures}",
        )

    def test_a_column_zeroed_for_the_whole_leg_fails(self) -> None:
        rows = self._leg()
        for row in rows:
            row["cpu_percent"] = "0"
        failures, _ = self.audit.check_invariants(rows, "rtmp")

        self.assertTrue(
            [f for f in failures if "cpu_percent" in f and "zero on every sample" in f],
            f"an all-zero required column is not an honest zero here: {failures}",
        )

    def test_moq_is_not_failed_for_the_rtt_it_has_no_instrument_for(self) -> None:
        """quic_rtt_ms/net_rtt_ms are known-unmeasured on the openmoq publisher."""
        rows = self._leg(protocol="moq")
        for row in rows:
            row["net_rtt_ms"] = "0"
        failures, _ = self.audit.check_invariants(rows, "moq")

        self.assertFalse(
            [f for f in failures if "net_rtt_ms" in f],
            f"a documented unmeasured stage must not be a failure: {failures}",
        )

    def test_segmentation_n_a_is_not_a_silent_zero(self) -> None:
        """SRT/RTMP without HLS remux mark segmentation n/a, not unmeasured."""
        rows = self._leg(protocol="srt")
        for row in rows:
            row["latency_segmentation_ms"] = "0.0"
            row["latency_unmeasured"] = "publish,packager"
            row["latency_not_applicable"] = "segmentation"
        failures, _ = self.audit.check_invariants(rows, "srt")
        self.assertFalse(
            [f for f in failures if "latency_segmentation_ms" in f and "silent zero" in f],
            f"n/a must be an honest zero: {failures}",
        )

    def test_encode_unmeasured_skips_the_absence_gate(self) -> None:
        rows = self._leg(protocol="moq")
        for row in rows:
            row["latency_encode_ms"] = "0.0"
            row["latency_unmeasured"] = "encode,publish,network,packager"
        failures, _ = self.audit.check_invariants(rows, "moq")
        self.assertFalse(
            [f for f in failures if "latency_encode_ms" in f and "collection failure" in f],
            f"an honestly unmeasured encode must not trip REQUIRED_NONZERO: {failures}",
        )


class PlausibilityGateTests(unittest.TestCase):
    """PLAUSIBLE was computed and printed for months without ever gating."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.audit = _load_audit()

    def test_a_unit_error_across_the_run_fails(self) -> None:
        rows = _rows(protocol="rtmp")
        for row in rows:
            row["encoded_bitrate_kbps"] = "2981100.0"
        failures, _ = self.audit.check_invariants(rows, "rtmp")

        self.assertTrue(
            [f for f in failures if "plausible window" in f],
            f"bitrate off by 1000x for the whole run must fail: {failures}",
        )

    def test_the_encoder_ramp_is_an_observation_not_a_failure(self) -> None:
        """Replays the MoQ leg's 10.6 kbps opening sample.

        The first non-zero sample covers a partial interval, so it reads low by
        construction. Failing a leg for it would make the gate unusable.
        """
        rows = _rows(protocol="moq")
        for i, row in enumerate(rows):
            row["encoded_bitrate_kbps"] = "10.6" if i == 0 else "5447.3"
        failures, observations = self.audit.check_invariants(rows, "moq")

        self.assertFalse(
            [f for f in failures if "plausible window" in f],
            f"a partial first interval is not a formula error: {failures}",
        )
        self.assertTrue(
            [o for o in observations if "partial interval at encoder start" in o],
            f"the ramp sample should still be visible: {observations}",
        )


class EncoderStallTests(unittest.TestCase):
    """A mid-run freeze must be visible, and must explain the fps gap it causes.

    Replays upload_20260823-022938_72699c63: the frame counter sat at 159 for
    2.9s with ``fps`` reporting 0.00, then resumed. Nothing reported the freeze
    — ``encode_frames_dropped`` stays 0 because nothing was dropped, it was
    never produced — and the audit blamed the resulting fps gap on the formula.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.audit = _load_audit()

    def _stalled_leg(self) -> List[dict]:
        rows: List[dict] = []
        frames, stamp = 0, 0.0
        for i in range(30):
            frozen = 6 <= i <= 8
            if not frozen:
                frames += 30
            rows.append(
                {
                    "protocol": "rtmp",
                    "timestamp": f"{stamp}",
                    "encode_frames_total": f"{frames}",
                    "fps": "0.0" if frozen else "31.5",
                    "fps_stability": "0.0305",
                    "cpu_percent": "66.9",
                    "latency_encode_ms": "549.3",
                    "encoded_bitrate_kbps": "2981.1",
                    "net_rtt_ms": "37.6",
                }
            )
            stamp += 1.0
        return rows

    def test_the_stall_is_reported_at_all(self) -> None:
        failures, observations = self.audit.check_invariants(self._stalled_leg(), "rtmp")
        self.assertTrue(
            [o for o in observations if "encoder stalled" in o],
            f"a mid-run freeze must be surfaced: {observations} / {failures}",
        )

    def test_the_stall_explains_the_gap_instead_of_the_formula(self) -> None:
        failures, observations = self.audit.check_invariants(self._stalled_leg(), "rtmp")
        self.assertFalse(
            [f for f in failures if "fps formula defect" in f],
            f"a stall-shaped gap is not a formula defect: {failures}",
        )
        self.assertTrue(
            [o for o in observations if "explained by the stall" in o],
            f"the gap should be attributed to the stall: {observations}",
        )

    def test_startup_idle_and_shutdown_are_not_stalls(self) -> None:
        """Leading zeros are startup and a trailing freeze is the run ending."""
        rows = self._stalled_leg()
        for i in (0, 1, 2):
            rows[i]["encode_frames_total"] = "0"
        tail = rows[-1]["encode_frames_total"]
        for row in rows[-4:]:
            row["encode_frames_total"] = tail

        stalls = self.audit.encoder_stalls(rows)
        self.assertEqual(
            1, len(stalls), f"only the mid-run freeze counts, got {stalls}"
        )

    def test_a_clean_leg_reports_no_stall(self) -> None:
        rows = self._stalled_leg()
        frames = 0
        for row in rows:
            frames += 30
            row["encode_frames_total"] = f"{frames}"
            row["fps"] = "30.0"
        self.assertEqual([], self.audit.encoder_stalls(rows))


class FpsVerdictChannelTests(unittest.TestCase):
    """An oscillating encoder is a product owner's problem, not a formula bug."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.audit = _load_audit()

    def test_an_oscillating_encoder_is_an_observation_not_a_failure(self) -> None:
        rows = _rows(protocol="moq", fps=33.0, fps_stability=0.1828)
        failures, observations = self.audit.check_invariants(rows, "moq")

        self.assertTrue(
            [o for o in observations if "unstable encode" in o],
            f"expected the oscillation to be reported: {observations}",
        )
        self.assertFalse(
            [f for f in failures if "unstable encode" in f],
            f"a rule that concludes both numbers are honest must not fail: {failures}",
        )

    def test_a_steady_encoder_with_two_fps_numbers_still_fails(self) -> None:
        """The defect the 8b rule exists for has to survive the split."""
        rows = _rows(protocol="rtmp", fps=33.0, fps_stability=0.01)
        failures, _ = self.audit.check_invariants(rows, "rtmp")

        self.assertTrue(
            [f for f in failures if "fps formula defect" in f],
            f"a steady encoder cannot hold two fps values this far apart: {failures}",
        )


if __name__ == "__main__":
    unittest.main()
