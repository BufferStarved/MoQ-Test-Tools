"""Matrix e2e cases must fail-close retired PUT recipes and gate MoQ Chrome."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_put_cases_assert_api_reject_not_silent_skip(self) -> None:
        by_id = {case["id"]: case for case in self.mod.CASES}
        for case_id in ("zixi_tsput_hls", "zixi_tsput_dash"):
            case = by_id[case_id]
            self.assertTrue(case.get("assert_api_reject"), case_id)
            self.assertFalse(case.get("skip"), case_id)
            self.assertEqual(case.get("known_gap"), "zixi_http_ts_push_retired")

    def test_linode_put_asserts_api_reject(self) -> None:
        by_id = {case["id"]: case for case in self.mod.LINODE_CASES}
        case = by_id["linode_zixi_tsput"]
        self.assertTrue(case.get("assert_api_reject"))
        self.assertFalse(case.get("skip"))

    def test_put_gate_runner_rejects_without_starting_job(self) -> None:
        case = {
            "id": "zixi_tsput_hls",
            "preset_id": "moq_zixi_gcp_hls",
            "known_gap": "zixi_http_ts_push_retired",
            "assert_api_reject": True,
        }

        def fake_api(method, path, data=None, files=None):
            if method == "GET" and path == "/api/presets":
                return {"presets": [{"id": "moq_zixi_gcp"}]}
            if method == "GET" and path == "/api/protocols":
                return {"protocols": [{"id": "srt"}, {"id": "moq"}]}
            if method == "POST" and path == "/api/uploads":
                raise RuntimeError(
                    "POST /api/uploads -> 400: Zixi HTTP-TS PUT ingest stops draining"
                )
            raise AssertionError(f"unexpected {method} {path}")

        with patch.object(self.mod, "api", side_effect=fake_api):
            result = self.mod.run_put_gate_case(case, "/tmp/dummy.mp4")
        self.assertTrue(result.ok)
        self.assertFalse(result.skipped)
        self.assertEqual(result.job_id, "")
        self.assertIn("api_reject_400", result.ingest)

    def test_put_gate_fails_if_recipe_is_startable(self) -> None:
        case = {
            "id": "zixi_tsput_hls",
            "preset_id": "moq_zixi_gcp_hls",
            "assert_api_reject": True,
        }

        def fake_api(method, path, data=None, files=None):
            if method == "GET" and path == "/api/presets":
                return {"presets": [{"id": "moq_zixi_gcp_hls"}]}
            if method == "GET" and path == "/api/protocols":
                return {"protocols": [{"id": "hls"}, {"id": "dash"}]}
            if method == "POST" and path == "/api/uploads":
                return {"id": "should-not-start"}
            raise AssertionError(f"unexpected {method} {path}")

        with patch.object(self.mod, "api", side_effect=fake_api):
            result = self.mod.run_put_gate_case(case, "/tmp/dummy.mp4")
        self.assertFalse(result.ok)
        self.assertIn("put_preset_still_listed", result.errors)
        self.assertIn("hls_dash_still_offered", result.errors)
        self.assertIn("put_start_not_rejected", result.errors)

    def test_moq_admin_from_sslip(self) -> None:
        leftover = self.mod.moq_admin_from_relay_url(
            "https://34-28-164-90.sslip.io:4433/moq-relay"
        )
        self.assertEqual(leftover, "http://34.28.164.90:8000")
        canary = self.mod.moq_admin_from_relay_url(
            "https://45-79-177-85.sslip.io:14433/moq-relay"
        )
        self.assertEqual(canary, "http://45.79.177.85:18000")

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

    def test_origin_probe_skips_moq_https(self) -> None:
        code, _n, note = self.mod.probe_http_origin("https://34-28-164-90.sslip.io:14433/moq-relay")
        self.assertEqual(code, 0)
        self.assertEqual(note, "skip_moq")

    def test_zixi_srt_playback_uses_error_concealed_stream(self) -> None:
        central = next(item for item in self.mod.CASES if item["id"] == "zixi_srt_mpegts")
        east = next(item for item in self.mod.EAST_CASES if item["id"] == "east_zixi_srt_mpegts")
        linode = next(item for item in self.mod.LINODE_CASES if item["id"] == "linode_zixi_srt_mpegts")
        for case in (central, east, linode):
            self.assertIn("SRT%20Test%20EC", case["url"], case["id"])
            self.assertNotIn("SRT%20Test.ts", case["url"], case["id"])

    def test_live_srt_hls_is_not_skipped(self) -> None:
        case = next(item for item in self.mod.CASES if item["id"] == "zixi_srt_hls")
        self.assertFalse(case.get("skip"))


if __name__ == "__main__":
    unittest.main()
