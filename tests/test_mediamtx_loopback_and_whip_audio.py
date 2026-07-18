"""MediaMTX loopback publish URL + WHIP Opus audio wiring."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import DestinationProfile  # noqa: E402
from moq_publish import (  # noqa: E402
    WHIP_COMPAT_AUDIO_ARGS,
    mediamtx_loopback_publish_url,
)
from upload_service import UploadJob  # noqa: E402
from zixi_hls_health import mediamtx_hls_probe_url  # noqa: E402


class MediaMtxLoopbackTests(unittest.TestCase):
    def test_rewrites_known_public_host(self) -> None:
        url = "srt://34.9.217.178:8890?mode=caller&streamid=publish:benchmark"
        out = mediamtx_loopback_publish_url(url)
        self.assertTrue(out.startswith("srt://127.0.0.1:8890?"))
        self.assertIn("streamid=publish:benchmark", out)

    def test_leaves_other_hosts(self) -> None:
        url = "rtmp://10.0.0.5:1935/benchmark"
        self.assertEqual(mediamtx_loopback_publish_url(url), url)

    def test_env_override(self) -> None:
        with patch.dict(os.environ, {"MEDIAMTX_PUBLIC_HOST": "1.2.3.4"}):
            self.assertEqual(
                mediamtx_loopback_publish_url("http://1.2.3.4:8889/benchmark/whip"),
                "http://127.0.0.1:8889/benchmark/whip",
            )


class MediaMtxProbeUrlTests(unittest.TestCase):
    def test_probe_uses_loopback(self) -> None:
        self.assertEqual(
            mediamtx_hls_probe_url("benchmark"),
            "http://127.0.0.1:8888/benchmark/index.m3u8",
        )


class MediaMtxStreamIdEncodingTests(unittest.TestCase):
    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_publish_streamid_keeps_colon(self, _ffmpeg) -> None:
        job = UploadJob(
            media_path="/tmp/x.mp4",
            destination=DestinationProfile(
                protocol="srt",
                url="srt://34.9.217.178:8890?mode=caller&latency=200000&streamid=publish:benchmark",
                preset_id="moq_mediamtx_gcp_srt",
                ingest_provider="gcp_mediamtx",
            ),
            duration_sec=5,
        )
        resolved = job._resolved_srt_destination_url()
        self.assertIn("streamid=publish:benchmark", resolved)
        self.assertNotIn("publish%3A", resolved)


class WhipAudioWiringTests(unittest.TestCase):
    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_whip_job_uses_opus(self, _ffmpeg) -> None:
        job = UploadJob(
            media_path="/tmp/x.mp4",
            destination=DestinationProfile(
                protocol="webrtc",
                url="http://34.9.217.178:8889/benchmark/whip",
                preset_id="moq_mediamtx_gcp_whip",
                ingest_provider="gcp_mediamtx",
            ),
            duration_sec=5,
            job_id="t",
        )
        cmd = job.ffmpeg_cmd
        self.assertIn("libopus", cmd)
        self.assertNotIn("aac", cmd)
        # Publish URL localized for co-located MediaMTX.
        self.assertIn("http://127.0.0.1:8889/benchmark/whip", cmd)
        self.assertEqual(WHIP_COMPAT_AUDIO_ARGS[1], "libopus")


if __name__ == "__main__":
    unittest.main()
