"""Matrix e2e cases must skip retired PUT recipes and gate MoQ Chrome."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "e2e_ingest_matrix_test.py"


def _load_matrix():
    spec = importlib.util.spec_from_file_location("e2e_ingest_matrix_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class E2eIngestMatrixGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.mod = _load_matrix()

    def test_put_cases_are_skipped_not_started(self) -> None:
        by_id = {case["id"]: case for case in self.mod.CASES}
        for case_id in ("zixi_tsput_hls", "zixi_tsput_dash"):
            case = by_id[case_id]
            self.assertTrue(case.get("skip"), case_id)
            self.assertIn("PUT", case.get("skip_reason") or "")
            result = self.mod.skipped_case_result(case)
            self.assertTrue(result.ok)
            self.assertTrue(result.skipped)
            self.assertTrue(result.gated)
            self.assertEqual(result.job_id, "")

    def test_linode_put_skipped_when_present(self) -> None:
        by_id = {case["id"]: case for case in self.mod.LINODE_CASES}
        case = by_id["linode_zixi_tsput"]
        self.assertTrue(case.get("skip"))
        self.assertIn("PUT", case.get("skip_reason") or "")

    def test_moq_requires_webtransport(self) -> None:
        for cases in (self.mod.CASES, self.mod.EAST_CASES, self.mod.LINODE_CASES):
            for case in cases:
                if case.get("playback") == "moq":
                    self.assertTrue(
                        case.get("requires_webtransport"),
                        case["id"],
                    )

    def test_srt_hls_dual_probes_mpegts(self) -> None:
        case = next(item for item in self.mod.CASES if item["id"] == "zixi_srt_hls")
        self.assertEqual(self.mod.chrome_modes_for_case(case), ["hls", "mpegts"])
        mpegts = next(item for item in self.mod.CASES if item["id"] == "zixi_srt_mpegts")
        self.assertTrue(mpegts.get("skip"))

    def test_live_srt_hls_is_not_skipped(self) -> None:
        case = next(item for item in self.mod.CASES if item["id"] == "zixi_srt_hls")
        self.assertFalse(case.get("skip"))


if __name__ == "__main__":
    unittest.main()
