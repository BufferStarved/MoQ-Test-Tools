"""Heal decision for wedged Zixi Fast HLS (EC recreate vs SRT reset)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from zixi_hls_health import zixi_fast_hls_origin_available, zixi_hls_heal_kind  # noqa: E402


class ZixiHlsHealKindTests(unittest.TestCase):
    def test_healthy_rolling_playlist_is_left_alone(self):
        self.assertIsNone(
            zixi_hls_heal_kind(
                health_ok=True,
                stale_rolling=False,
                stuck=False,
                uses_ec=True,
            )
        )

    def test_stale_ec_playlist_recreates_ec_not_srt(self):
        self.assertEqual(
            zixi_hls_heal_kind(
                health_ok=True,
                stale_rolling=True,
                stuck=False,
                uses_ec=True,
            ),
            "ec_recreate",
        )

    def test_stale_primary_playlist_resets_srt(self):
        self.assertEqual(
            zixi_hls_heal_kind(
                health_ok=True,
                stale_rolling=True,
                stuck=False,
                uses_ec=False,
            ),
            "srt_reset",
        )

    def test_unreadable_ec_segments_recreate_ec(self):
        self.assertEqual(
            zixi_hls_heal_kind(
                health_ok=False,
                stale_rolling=False,
                stuck=True,
                uses_ec=True,
            ),
            "ec_recreate",
        )

    def test_unreadable_primary_segments_reset_srt(self):
        self.assertEqual(
            zixi_hls_heal_kind(
                health_ok=False,
                stale_rolling=False,
                stuck=True,
                uses_ec=False,
            ),
            "srt_reset",
        )

    def test_brief_probe_miss_is_not_stuck(self):
        self.assertIsNone(
            zixi_hls_heal_kind(
                health_ok=False,
                stale_rolling=False,
                stuck=False,
                uses_ec=True,
            )
        )


class ZixiFastHlsOriginTests(unittest.TestCase):
    def test_central_broadcaster_has_fast_hls(self):
        self.assertTrue(zixi_fast_hls_origin_available(ingest_provider="gcp_zixi"))
        self.assertTrue(
            zixi_fast_hls_origin_available(
                endpoint_url="srt://35.222.33.58:10080?mode=caller"
            )
        )

    def test_east_and_linode_edge_compute_do_not(self):
        self.assertFalse(zixi_fast_hls_origin_available(ingest_provider="gcp_east_zixi"))
        self.assertFalse(zixi_fast_hls_origin_available(ingest_provider="linode_zixi"))
        self.assertFalse(
            zixi_fast_hls_origin_available(
                endpoint_url="srt://35.196.215.179:10080?mode=caller"
            )
        )
        self.assertFalse(
            zixi_fast_hls_origin_available(
                endpoint_url="srt://45.33.68.151:10080?mode=caller"
            )
        )


if __name__ == "__main__":
    unittest.main()
