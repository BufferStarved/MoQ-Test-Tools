"""Cloud placement + Linode stack env wiring."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from cloud_placement import (
    ENCODE_HOSTS,
    encode_hosts_for_api,
    gcp_east_stack_configured,
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
        self.assertEqual(ingest_endpoint_id_for_provider("gcp_east_zixi"), "gcp_east_zixi")

    def test_gcp_east_provider_inference(self) -> None:
        with mock.patch.dict(os.environ, {"GCP_EAST_REGION": "us-east1"}, clear=False):
            placement = placement_from_ingest_provider("gcp_east_mediamtx")
        self.assertEqual(placement.cloud_provider, "gcp")
        self.assertEqual(placement.cloud_region, "us-east1")

    def test_nine_host_registry_labels_and_slugs(self) -> None:
        expected = [
            ("gcp_east", "GCP East", "gcp", "east", "us-east1"),
            ("gcp_central", "GCP Central", "gcp", "central", "us-central1"),
            ("gcp_west", "GCP West", "gcp", "west", "us-west1"),
            ("linode_east", "Linode East", "linode", "east", "us-east"),
            ("linode_central", "Linode Central", "linode", "central", "us-central"),
            ("linode_west", "Linode West", "linode", "west", "us-west"),
            ("aws_east", "AWS East", "aws", "east", "us-east-1"),
            ("aws_central", "AWS Central", "aws", "central", "us-east-2"),
            ("aws_west", "AWS West", "aws", "west", "us-west-2"),
        ]
        self.assertEqual(len(ENCODE_HOSTS), 9)
        self.assertEqual(
            [
                (host.id, host.label, host.provider, host.region, host.cloud_region)
                for host in ENCODE_HOSTS
            ],
            expected,
        )

    def test_encode_hosts_api_shows_undeployed_grid(self) -> None:
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith(("GCP_EAST_", "GCP_WEST_", "LINODE_", "AWS_"))
        }
        with mock.patch.dict(os.environ, env, clear=True):
            hosts = {host["id"]: host for host in encode_hosts_for_api()}
        self.assertEqual(len(hosts), 9)
        self.assertEqual(hosts["gcp_central"]["label"], "GCP Central")
        self.assertTrue(hosts["gcp_central"]["available"])
        self.assertFalse(hosts["gcp_central"]["roles"]["zixi"])
        self.assertIn("35.222.33.58", hosts["gcp_central"]["unavailable_reason"])
        self.assertFalse(hosts["gcp_west"]["available"])
        self.assertEqual(hosts["gcp_west"]["unavailable_reason"], "Not deployed")
        self.assertFalse(hosts["aws_east"]["available"])
        self.assertEqual(hosts["linode_central"]["cloud_region"], "us-central")
        self.assertIn("Dallas", hosts["linode_central"]["subtitle"])
        self.assertNotIn("4433", str(hosts))

    def test_west_prefix_does_not_collapse_to_central(self) -> None:
        with mock.patch.dict(os.environ, {"GCP_WEST_REGION": "us-west1"}, clear=False):
            placement = placement_from_ingest_provider("gcp_west_moq_relay_d18")
        self.assertEqual(placement.cloud_provider, "gcp")
        self.assertEqual(placement.cloud_region, "us-west1")


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
            stub = dest_mod.PRESET_BY_ID["moq_zixi_linode"]
            self.assertFalse(stub.web_available)
            self.assertEqual(stub.notes, "Not deployed")
            self.assertNotIn("zixi_linode_srt", dest_mod.PRESET_BY_ID)

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

    def test_partial_stack_greys_missing_software(self) -> None:
        env = {
            "LINODE_STACK_ENABLED": "1",
            "LINODE_ZIXI_IP": "203.0.113.10",
            "LINODE_WEB_IP": "",
            "LINODE_RELAY_IP": "",
            "LINODE_REGION": "us-east",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import importlib
            import destinations as dest_mod
            import cloud_placement as place_mod

            importlib.reload(place_mod)
            importlib.reload(dest_mod)
            self.assertTrue(dest_mod.PRESET_BY_ID["moq_zixi_linode"].web_available)
            self.assertFalse(dest_mod.PRESET_BY_ID["moq_mediamtx_linode_srt"].web_available)
            self.assertFalse(dest_mod.PRESET_BY_ID["moq_linode_relay_d18"].web_available)
            hosts = {row["id"]: row for row in place_mod.encode_hosts_for_api()}
            self.assertTrue(hosts["linode_east"]["available"])
            self.assertTrue(hosts["linode_east"]["roles"]["zixi"])
            self.assertFalse(hosts["linode_east"]["roles"]["mediamtx"])
            self.assertFalse(hosts["linode_east"]["roles"]["moq"])
            self.assertIn("mediamtx", hosts["linode_east"]["unavailable_reason"])

    def test_linode_central_greys_zixi_until_ip_is_set(self) -> None:
        env = {
            "LINODE_CENTRAL_STACK_ENABLED": "1",
            "LINODE_CENTRAL_ZIXI_IP": "",
            "LINODE_CENTRAL_WEB_IP": "50.116.17.198",
            "LINODE_CENTRAL_RELAY_IP": "66.228.49.113",
            "LINODE_CENTRAL_REGION": "us-central",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import importlib
            import destinations as dest_mod
            import cloud_placement as place_mod

            importlib.reload(place_mod)
            importlib.reload(dest_mod)
            self.assertFalse(dest_mod.PRESET_BY_ID["moq_zixi_linode_central"].web_available)
            self.assertTrue(dest_mod.PRESET_BY_ID["moq_mediamtx_linode_central_srt"].web_available)
            self.assertTrue(dest_mod.PRESET_BY_ID["moq_linode_central_relay_d18"].web_available)
            hosts = {row["id"]: row for row in place_mod.encode_hosts_for_api()}
            self.assertTrue(hosts["linode_central"]["available"])
            self.assertFalse(hosts["linode_central"]["roles"]["zixi"])
            self.assertTrue(hosts["linode_central"]["roles"]["mediamtx"])
            self.assertTrue(hosts["linode_central"]["roles"]["moq"])
            self.assertEqual(hosts["linode_central"]["unavailable_reason"], "Not deployed: zixi")


class MoqRecorderAgentTests(unittest.TestCase):
    def test_dallas_and_fremont_agents_use_regional_tokens(self) -> None:
        env = {
            "INGEST_AGENT_TOKEN": "central-token",
            "LINODE_CENTRAL_INGEST_AGENT_TOKEN": "dallas-token",
            "LINODE_WEST_INGEST_AGENT_TOKEN": "fremont-token",
            "LINODE_CENTRAL_WEB_IP": "50.116.17.198",
            "LINODE_WEST_WEB_IP": "173.230.155.121",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            from ingest_agent_client import resolve_ingest_agent

            dallas = resolve_ingest_agent(agent_url="http://50.116.17.198:8090")
            fremont = resolve_ingest_agent(agent_url="http://173.230.155.121:8090")
            self.assertIsNotNone(dallas)
            self.assertIsNotNone(fremont)
            self.assertEqual(dallas.token, "dallas-token")
            self.assertEqual(fremont.token, "fremont-token")

    def test_east_and_linode_moq_record_on_central_web_agent(self) -> None:
        env = {
            "MOQ_RECORDER_AGENT_URL": "http://35.222.33.58:8090",
            "LINODE_STACK_ENABLED": "1",
            "LINODE_ZIXI_IP": "203.0.113.10",
            "LINODE_WEB_IP": "203.0.113.20",
            "LINODE_RELAY_IP": "203.0.113.30",
            "GCP_EAST_STACK_ENABLED": "1",
            "GCP_EAST_ZIXI_IP": "203.0.113.40",
            "GCP_EAST_WEB_IP": "203.0.113.50",
            "GCP_EAST_RELAY_IP": "203.0.113.60",
            "LINODE_CENTRAL_STACK_ENABLED": "1",
            "LINODE_CENTRAL_WEB_IP": "50.116.17.198",
            "LINODE_CENTRAL_RELAY_IP": "66.228.49.113",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import importlib
            import destinations as dest_mod

            importlib.reload(dest_mod)
            # Zixi override is rejected; MoQ VMAF uses the proven central web
            # recorder (Dallas/Linode local handshake fails).
            self.assertEqual(
                dest_mod.PRESET_BY_ID["moq_linode_relay"].ingest_agent_url,
                dest_mod.CENTRAL_WEB_INGEST_AGENT,
            )
            self.assertEqual(
                dest_mod.PRESET_BY_ID["moq_gcp_east_relay"].ingest_agent_url,
                dest_mod.CENTRAL_WEB_INGEST_AGENT,
            )
            self.assertEqual(
                dest_mod.PRESET_BY_ID["moq_linode_central_relay"].ingest_agent_url,
                dest_mod.CENTRAL_WEB_INGEST_AGENT,
            )
            self.assertEqual(
                dest_mod.PRESET_BY_ID["moq_linode_central_relay_d18"].ingest_agent_url,
                dest_mod.CENTRAL_WEB_INGEST_AGENT,
            )
            self.assertNotIn(
                "35.222.33.58",
                dest_mod.PRESET_BY_ID["moq_gcp_relay"].ingest_agent_url,
            )
            # Zixi SRT still records on the regional ingest worker.
            self.assertEqual(
                dest_mod.PRESET_BY_ID["moq_zixi_linode"].ingest_agent_url,
                "http://203.0.113.10:8090",
            )

    def test_moq_recorder_env_override_when_not_dead_zixi(self) -> None:
        env = {
            "MOQ_RECORDER_AGENT_URL": "http://203.0.113.99:8090",
            "LINODE_STACK_ENABLED": "1",
            "LINODE_ZIXI_IP": "203.0.113.10",
            "LINODE_WEB_IP": "203.0.113.20",
            "LINODE_RELAY_IP": "203.0.113.30",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import importlib
            import destinations as dest_mod

            importlib.reload(dest_mod)
            self.assertEqual(
                dest_mod.PRESET_BY_ID["moq_linode_relay"].ingest_agent_url,
                "http://203.0.113.99:8090",
            )


class GcpEastPresetTests(unittest.TestCase):
    def test_east_presets_hidden_without_env(self) -> None:
        env = {
            k: v
            for k, v in os.environ.items()
            if not k.startswith("GCP_EAST_")
        }
        with mock.patch.dict(os.environ, env, clear=True):
            import importlib
            import destinations as dest_mod

            importlib.reload(dest_mod)
            stub = dest_mod.PRESET_BY_ID["moq_zixi_gcp_east"]
            self.assertFalse(stub.web_available)
            self.assertFalse(gcp_east_stack_configured())

    def test_east_presets_registered_when_configured(self) -> None:
        env = {
            "GCP_EAST_STACK_ENABLED": "1",
            "GCP_EAST_ZIXI_IP": "203.0.113.40",
            "GCP_EAST_WEB_IP": "203.0.113.50",
            "GCP_EAST_RELAY_IP": "203.0.113.60",
            "GCP_EAST_REGION": "us-east1",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import importlib
            import destinations as dest_mod

            importlib.reload(dest_mod)
            preset = dest_mod.PRESET_BY_ID["moq_mediamtx_gcp_east_srt"]
            self.assertTrue(preset.web_available)
            self.assertIn("203.0.113.50", preset.url)
            self.assertEqual(preset.cloud_provider, "gcp")
            self.assertEqual(preset.cloud_region, "us-east1")
            hosts = {host["id"]: host for host in encode_hosts_for_api()}
            self.assertTrue(hosts["gcp_east"]["available"])
            self.assertTrue(hosts["gcp_central"]["available"])
            self.assertFalse(hosts["gcp_west"]["available"])
            self.assertIn("moq_gcp_east_relay_d18", dest_mod.PRESET_BY_ID)
            self.assertIn(":14433", dest_mod.PRESET_BY_ID["moq_gcp_east_relay_d18"].url)
            self.assertNotIn(":4433", dest_mod.PRESET_BY_ID["moq_gcp_east_relay_d18"].url)

    def test_east_agent_uses_region_token(self) -> None:
        env = {
            "INGEST_AGENT_TOKEN": "central-token",
            "GCP_EAST_INGEST_AGENT_TOKEN": "east-token",
            "GCP_EAST_ZIXI_IP": "203.0.113.40",
            "GCP_EAST_WEB_IP": "203.0.113.50",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            from ingest_agent_client import resolve_ingest_agent

            east = resolve_ingest_agent(agent_url="http://203.0.113.40:8090")
            central = resolve_ingest_agent(agent_url="http://35.222.33.58:8090")
            self.assertIsNotNone(east)
            self.assertIsNotNone(central)
            self.assertEqual(east.token, "east-token")
            self.assertEqual(central.token, "central-token")

    def test_health_timeout_is_short(self) -> None:
        from ingest_agent_client import HEALTH_TIMEOUT_SEC

        self.assertLessEqual(HEALTH_TIMEOUT_SEC, 2.0)

    def test_reserved_gcp_west_env_unlocks_fourth_stack(self) -> None:
        env = {
            "GCP_WEST_STACK_ENABLED": "1",
            "GCP_WEST_ZIXI_IP": "203.0.113.70",
            "GCP_WEST_WEB_IP": "203.0.113.80",
            "GCP_WEST_RELAY_IP": "203.0.113.90",
            "GCP_WEST_REGION": "us-west1",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import importlib
            import destinations as dest_mod

            importlib.reload(dest_mod)
            try:
                preset = dest_mod.PRESET_BY_ID["moq_gcp_west_relay_d18"]
                self.assertTrue(preset.web_available)
                self.assertIn(":14433", preset.url)
                self.assertEqual(preset.cloud_region, "us-west1")
                hosts = {host["id"]: host for host in encode_hosts_for_api()}
                self.assertTrue(hosts["gcp_west"]["available"])
                self.assertEqual(hosts["gcp_west"]["label"], "GCP West")
            finally:
                importlib.reload(dest_mod)

    def test_linode_agent_does_not_fall_back_to_central_token(self) -> None:
        env = {
            "INGEST_AGENT_TOKEN": "central-token",
            "LINODE_INGEST_AGENT_TOKEN": "",
            "LINODE_ZIXI_IP": "203.0.113.10",
            "LINODE_WEB_IP": "203.0.113.20",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            import ingest_agent_client as agent_mod

            linode = agent_mod.resolve_ingest_agent(agent_url="http://203.0.113.10:8090")
            self.assertIsNone(linode)
            with mock.patch.dict(os.environ, {"LINODE_INGEST_AGENT_TOKEN": "linode-token"}):
                linode_ok = agent_mod.resolve_ingest_agent(agent_url="http://203.0.113.10:8090")
                self.assertIsNotNone(linode_ok)
                self.assertEqual(linode_ok.token, "linode-token")


class ZixiGcpEncodeGateTests(unittest.TestCase):
    def test_central_zixi_srt_rtmp_are_not_startable(self) -> None:
        from destinations import (
            PRESET_BY_ID,
            ZIXI_GCP_ENCODE_UNAVAILABLE_REASON,
            zixi_gcp_encode_blocked,
        )

        for preset_id in ("moq_zixi_gcp", "moq_zixi_gcp_rtmp"):
            preset = PRESET_BY_ID[preset_id]
            self.assertFalse(preset.web_available, preset_id)
            self.assertIn("35.222.33.58", preset.notes)
            reason = zixi_gcp_encode_blocked(preset_id, url=preset.url)
            self.assertEqual(reason, ZIXI_GCP_ENCODE_UNAVAILABLE_REASON)

    def test_custom_url_to_dead_zixi_is_blocked(self) -> None:
        from destinations import zixi_gcp_encode_blocked

        reason = zixi_gcp_encode_blocked(
            url="srt://35.222.33.58:10080?mode=caller",
        )
        self.assertIsNotNone(reason)
        self.assertIn("35.222.33.58", reason or "")

    def test_central_mediamtx_and_moq_stay_open(self) -> None:
        from destinations import PRESET_BY_ID, zixi_gcp_encode_blocked

        self.assertTrue(PRESET_BY_ID["moq_mediamtx_gcp_srt"].web_available)
        self.assertTrue(PRESET_BY_ID["moq_gcp_relay_d18"].web_available)
        self.assertIsNone(
            zixi_gcp_encode_blocked(
                "moq_gcp_relay_d18",
                url=PRESET_BY_ID["moq_gcp_relay_d18"].url,
            )
        )


if __name__ == "__main__":
    unittest.main()
