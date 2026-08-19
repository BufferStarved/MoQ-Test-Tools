"""Retired Zixi HTTP-TS PUT recipes must stay hidden and fail-closed."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

os.environ.setdefault("LOCAL_PUBLISHER_ENABLED", "0")

from fastapi.testclient import TestClient  # noqa: E402

import destinations  # noqa: E402
import main as api_main  # noqa: E402


PUT_PRESET_IDS = (
    "moq_zixi_gcp_hls",
    "moq_zixi_gcp_dash",
)


class HttpTsPutGateTests(unittest.TestCase):
    def test_central_put_presets_hidden(self) -> None:
        for preset_id in PUT_PRESET_IDS:
            preset = destinations.PRESET_BY_ID[preset_id]
            self.assertFalse(preset.web_available, preset_id)
            self.assertFalse(preset.web_visible, preset_id)
            reason = destinations.http_ts_put_preset_blocked(preset_id)
            self.assertIsNotNone(reason)
            self.assertIn("PUT", reason)

    def test_web_presets_omit_put_recipes(self) -> None:
        ids = {item["id"] for item in destinations.presets_for_api(web_only=True)}
        for preset_id in PUT_PRESET_IDS:
            self.assertNotIn(preset_id, ids)
        self.assertIn("moq_zixi_gcp", ids)
        self.assertIn("moq_zixi_gcp_rtmp", ids)

    def test_web_protocols_omit_hls_dash(self) -> None:
        self.assertNotIn("hls", destinations.WEB_OFFERED_PROTOCOLS)
        self.assertNotIn("dash", destinations.WEB_OFFERED_PROTOCOLS)
        self.assertIn("srt", destinations.WEB_OFFERED_PROTOCOLS)

    def test_regional_put_presets_hidden_when_configured(self) -> None:
        env = {
            "LINODE_STACK_ENABLED": "1",
            "LINODE_ZIXI_IP": "203.0.113.10",
            "LINODE_WEB_IP": "203.0.113.20",
            "LINODE_RELAY_IP": "203.0.113.30",
            "GCP_EAST_STACK_ENABLED": "1",
            "GCP_EAST_ZIXI_IP": "203.0.113.40",
            "GCP_EAST_WEB_IP": "203.0.113.50",
            "GCP_EAST_RELAY_IP": "203.0.113.60",
        }
        with patch.dict(os.environ, env, clear=False):
            import importlib

            dest_mod = importlib.reload(destinations)
            try:
                for preset_id in (
                    "moq_zixi_linode_hls",
                    "moq_zixi_linode_dash",
                    "moq_zixi_gcp_east_hls",
                    "moq_zixi_gcp_east_dash",
                ):
                    preset = dest_mod.PRESET_BY_ID[preset_id]
                    self.assertFalse(preset.web_available, preset_id)
                    self.assertFalse(preset.web_visible, preset_id)
                    self.assertIsNotNone(dest_mod.http_ts_put_preset_blocked(preset_id))
            finally:
                importlib.reload(destinations)

    def test_api_rejects_put_start(self) -> None:
        client = TestClient(api_main.app)
        with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
            tmp.write(b"not-a-real-mp4")
            tmp.flush()
            for preset_id in PUT_PRESET_IDS:
                resp = client.post(
                    "/api/uploads",
                    json={
                        "media_path": tmp.name,
                        "preset_id": preset_id,
                        "duration_sec": 5,
                    },
                )
                self.assertEqual(resp.status_code, 400, resp.text)
                detail = resp.json()["detail"].lower()
                self.assertTrue("put" in detail or "retired" in detail, detail)

    def test_api_protocols_hide_hls_dash(self) -> None:
        client = TestClient(api_main.app)
        resp = client.get("/api/protocols")
        self.assertEqual(resp.status_code, 200)
        ids = {item["id"] for item in resp.json()["protocols"]}
        self.assertNotIn("hls", ids)
        self.assertNotIn("dash", ids)
        self.assertIn("srt", ids)
        self.assertIn("moq", ids)

    def test_api_presets_hide_put_recipes(self) -> None:
        client = TestClient(api_main.app)
        resp = client.get("/api/presets")
        self.assertEqual(resp.status_code, 200)
        ids = {item["id"] for item in resp.json()["presets"]}
        for preset_id in PUT_PRESET_IDS:
            self.assertNotIn(preset_id, ids)


if __name__ == "__main__":
    unittest.main()
