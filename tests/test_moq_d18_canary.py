"""Draft-18 canary preset stays off the prod :4433 path."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from cloud_placement import ingest_endpoint_id_for_provider  # noqa: E402
from destinations import PRESET_BY_ID  # noqa: E402
from moq_publish import (  # noqa: E402
    moq_publisher_backend_for_preset,
    parse_moq_publish_url,
)


class Draft18CanaryPresetTests(unittest.TestCase):
    def test_prod_preset_stays_on_4433(self) -> None:
        preset = PRESET_BY_ID["moq_gcp_relay"]
        self.assertIn(":4433/", preset.url)
        self.assertNotIn(":14433", preset.url)
        self.assertEqual(preset.ingest_provider, "gcp_moq_relay")

    def test_canary_preset_points_at_14433_draft_18(self) -> None:
        preset = PRESET_BY_ID["moq_gcp_relay_d18"]
        self.assertIn(":14433/", preset.url)
        self.assertIn("draft=18", preset.url)
        self.assertTrue(preset.web_visible)
        self.assertTrue(preset.web_available)
        target = parse_moq_publish_url(preset.url)
        self.assertEqual(target.draft, 18)
        self.assertTrue(target.endpoint.endswith(":14433/moq-relay"))

    def test_canary_forces_moq5_even_when_env_says_openmoq(self) -> None:
        self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_relay_d18"), "moq5")
        self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_east_relay_d18"), "moq5")
        self.assertEqual(moq_publisher_backend_for_preset("moq_linode_relay_d18"), "moq5")
        with patch.dict(os.environ, {"MOQ_PUBLISHER_BACKEND": "openmoq"}):
            self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_relay_d18"), "moq5")
            self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_east_relay_d18"), "moq5")
            self.assertEqual(moq_publisher_backend_for_preset("moq_linode_relay_d18"), "moq5")
            self.assertEqual(moq_publisher_backend_for_preset("moq_gcp_relay"), "openmoq")
            self.assertEqual(moq_publisher_backend_for_preset(""), "openmoq")

    def test_ingest_provider_maps_to_distinct_ui_endpoint(self) -> None:
        self.assertEqual(ingest_endpoint_id_for_provider("gcp_moq_relay"), "gcp_moq_relay")
        self.assertEqual(
            ingest_endpoint_id_for_provider("gcp_moq_relay_d18"), "gcp_moq_relay_d18"
        )
        self.assertEqual(
            ingest_endpoint_id_for_provider("gcp_east_moq_relay_d18"),
            "gcp_east_moq_relay_d18",
        )
        self.assertEqual(
            ingest_endpoint_id_for_provider("linode_moq_relay_d18"),
            "linode_moq_relay_d18",
        )

    def test_regional_canary_presets_use_14433_when_stack_configured(self) -> None:
        for preset_id in ("moq_gcp_east_relay_d18", "moq_linode_relay_d18"):
            preset = PRESET_BY_ID.get(preset_id)
            if preset is None:
                continue
            self.assertIn(":14433/", preset.url)
            self.assertIn("draft=18", preset.url)
            target = parse_moq_publish_url(preset.url)
            self.assertEqual(target.draft, 18)
            self.assertTrue(target.endpoint.endswith(":14433/moq-relay"))


if __name__ == "__main__":
    unittest.main()
