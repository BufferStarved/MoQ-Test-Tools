"""RTMP/HTTP-TS preflight must not consume live job media."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from endpoint_probe import (  # noqa: E402
    DEFAULT_PREFLIGHT_DURATION_SEC,
    probe_endpoint,
    probe_rtmp_endpoint,
)


class EndpointProbeTests(unittest.TestCase):
    def test_default_preflight_is_sub_second(self):
        self.assertLessEqual(DEFAULT_PREFLIGHT_DURATION_SEC, 0.5)

    @patch("endpoint_probe._tcp_connect_ok", return_value=(True, ""))
    def test_managed_zixi_rtmp_skips_lavfi_publish(self, _tcp):
        ok, err = probe_endpoint(
            "rtmp",
            "rtmp://35.222.33.58:1935/live/benchmark",
            "udp://127.0.0.1:19001",
            ingest_provider="gcp_zixi",
        )
        self.assertTrue(ok)
        self.assertEqual(err, "")

    @patch("endpoint_probe.subprocess.run")
    @patch("endpoint_probe._tcp_connect_ok", return_value=(True, ""))
    def test_rtmp_publish_uses_lavfi_not_media_path(self, _tcp, run):
        run.return_value.returncode = 0
        run.return_value.stderr = ""
        ok, err = probe_rtmp_endpoint(
            "rtmp://example:1935/live/benchmark",
            "udp://127.0.0.1:19001",
            skip_publish=False,
        )
        self.assertTrue(ok)
        self.assertEqual(err, "")
        cmd = run.call_args.args[0]
        self.assertIn("lavfi", cmd)
        self.assertIn("testsrc=size=320x180:rate=30", cmd)
        self.assertNotIn("udp://127.0.0.1:19001", cmd)


class RtmpStreamIdTests(unittest.TestCase):
    def test_preset_and_url_helpers(self):
        from moq_publish import zixi_rtmp_stream_id_for_preset, zixi_stream_id_from_rtmp_url

        self.assertEqual(zixi_rtmp_stream_id_for_preset("moq_zixi_gcp_rtmp"), "benchmark")
        self.assertIsNone(zixi_rtmp_stream_id_for_preset("moq_zixi_gcp"))
        self.assertEqual(
            zixi_stream_id_from_rtmp_url("rtmp://host:1935/live/benchmark"),
            "benchmark",
        )


if __name__ == "__main__":
    unittest.main()
