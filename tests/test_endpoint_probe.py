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
        from moq_publish import (
            zixi_http_push_stream_id_for_preset,
            zixi_rtmp_stream_id_for_preset,
            zixi_srt_stream_id_for_preset,
            zixi_stream_id_from_rtmp_url,
        )

        self.assertEqual(zixi_rtmp_stream_id_for_preset("moq_zixi_gcp_rtmp"), "benchmark")
        self.assertEqual(zixi_rtmp_stream_id_for_preset("moq_zixi_gcp_east_rtmp"), "benchmark")
        self.assertIsNone(zixi_rtmp_stream_id_for_preset("moq_zixi_gcp"))
        self.assertEqual(zixi_srt_stream_id_for_preset("moq_zixi_gcp_east"), "SRT Test")
        self.assertEqual(zixi_http_push_stream_id_for_preset("moq_zixi_gcp_east_hls"), "benchmark")
        self.assertEqual(
            zixi_stream_id_from_rtmp_url("rtmp://host:1935/live/benchmark"),
            "benchmark",
        )

    def test_mediamtx_rtmp_gets_unique_job_path_zixi_does_not(self):
        from moq_publish import apply_mediamtx_rtmp_job_path, mediamtx_rtmp_job_path

        job_id = "a1b2c3d4-1111-2222-3333-444444444444"
        self.assertEqual(mediamtx_rtmp_job_path(job_id), "benchmark-a1b2c3d4")
        self.assertEqual(
            apply_mediamtx_rtmp_job_path(
                "rtmp://173.230.155.121:1935/benchmark",
                protocol="rtmp",
                ingest_provider="linode_west_mediamtx",
                job_id=job_id,
            ),
            "rtmp://173.230.155.121:1935/benchmark-a1b2c3d4",
        )
        self.assertEqual(
            apply_mediamtx_rtmp_job_path(
                "rtmp://35.222.33.58:1935/live/benchmark",
                protocol="rtmp",
                ingest_provider="gcp_zixi",
                job_id=job_id,
            ),
            "rtmp://35.222.33.58:1935/live/benchmark",
        )
        self.assertEqual(
            apply_mediamtx_rtmp_job_path(
                "srt://173.230.155.121:8890?mode=caller&streamid=publish:benchmark",
                protocol="srt",
                ingest_provider="linode_west_mediamtx",
                job_id=job_id,
            ),
            "srt://173.230.155.121:8890?mode=caller&streamid=publish:benchmark",
        )


class ZixiSrtStreamIdTests(unittest.TestCase):
    def test_ensure_zixi_srt_streamid_on_bare_url_and_localhost(self) -> None:
        from destinations import PRESET_BY_ID
        from moq_publish import ensure_zixi_srt_streamid

        attached = ensure_zixi_srt_streamid(
            "srt://35.222.33.58:10080?mode=caller&latency=200000"
        )
        self.assertIn("streamid=", attached)
        self.assertIn("SRT%20Test", attached)
        self.assertEqual(
            attached,
            "srt://35.222.33.58:10080?mode=caller&latency=200000&streamid=#!::r=SRT%20Test,m=publish",
        )

        local = ensure_zixi_srt_streamid(
            "srt://127.0.0.1:10080?mode=caller&latency=200000"
        )
        self.assertNotIn("streamid=", local)

        mediamtx = (
            "srt://34.9.217.178:8890?mode=caller&latency=200000&streamid=publish:benchmark"
        )
        self.assertEqual(ensure_zixi_srt_streamid(mediamtx), mediamtx)
        self.assertIn("publish:benchmark", ensure_zixi_srt_streamid(mediamtx))

        preset_url = PRESET_BY_ID["moq_zixi_gcp"].url
        self.assertIn("streamid=", preset_url)
        self.assertIn("SRT%20Test", preset_url)


if __name__ == "__main__":
    unittest.main()
