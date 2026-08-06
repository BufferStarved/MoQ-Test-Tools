"""Cloud placement + Linode stack env wiring."""

from __future__ import annotations

import os
import unittest
from unittest import mock

from cloud_placement import (
    ingest_endpoint_id_for_provider,
    linode_stack_configured,
    merge_placement,
    placement_from_ingest_provider,
)
from destinations import PRESET_BY_ID, SERVICE_PRESETS


class CloudPlacementTests(unittest.TestCase):
    def test_gcp_provider_inference(self) -> None:
        placement = placement_from_ingest_provider("gcp_zixi")
        self.assertEqual(placement.cloud_provider, "gcp")
        self.assertEqual(placement.cloud_region, "us-central1")

    def test_linode_provider_inference(self) -> None:
        with mock.patch.dict(os.environ, {"LINODE_REGION": "eu-central"}, clear=False):
            placement = placement_from_ingest_provider("linode_mediamtx")
        self.assertEqual(placement.cloud_provider, "linode")
        self.assertEqual(placement.cloud_region, "eu-central")

    def test_merge_explicit_overrides(self) -> None:
        placement = merge_placement(
            cloud_provider="linode",
            cloud_region="ap-south",
            ingest_provider="gcp_zixi",
        )
        self.assertEqual(placement.cloud_provider, "linode")
        self.assertEqual(placement.cloud_region, "ap-south")

    def test_ingest_endpoint_id_mapping(self) -> None:
        self.assertEqual(ingest_endpoint_id_for_provider("linode_moq_relay"), "linode_moq_relay")


class LinodePresetTests(unittest.TestCase):
    def test_linode_presets_hidden_without_env(self) -> None:
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in {"LINODE_STACK_ENABLED", "LINODE_ZIXI_IP", "LINODE_WEB_IP", "LINODE_RELAY_IP"}
        }
        with mock.patch.dict(os.environ, env, clear=True):
            import importlib
            import destinations as dest_mod

            importlib.reload(dest_mod)
            self.assertNotIn("moq_zixi_linode", dest_mod.PRESET_BY_ID)
            self.assertIn("zixi_linode_srt", dest_mod.PRESET_BY_ID)

    def test_linode_presets_registered_when_configured(self) -> None:
        env = {
            "LINODE_STACK_ENABLED": "1",
            "LINODE_ZIXI_IP": "203.0.113.10",
            "LINODE_WEB_IP": "203.0.113.20",
            "LINODE_RELAY_IP": "203.0.113.30",
            "LINODE_REGION": "us-east",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import importlib
            import destinations as dest_mod

            importlib.reload(dest_mod)
            preset = dest_mod.PRESET_BY_ID["moq_mediamtx_linode_srt"]
            self.assertTrue(preset.web_available)
            self.assertIn("203.0.113.20", preset.url)
            self.assertEqual(preset.cloud_provider, "linode")
            self.assertEqual(preset.cloud_region, "us-east")
            profile = dest_mod.resolve_preset("moq_zixi_linode")
            self.assertEqual(profile.cloud_provider, "linode")
            self.assertEqual(profile.cloud_region, "us-east")


if __name__ == "__main__":
    unittest.main()
