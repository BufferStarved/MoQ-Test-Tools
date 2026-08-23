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
