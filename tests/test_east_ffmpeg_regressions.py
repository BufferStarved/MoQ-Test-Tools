"""Regressions from the 2026-08-18 local-ffmpeg → GCP East four-protocol run.

WebRTC died instantly (ffmpeg 69 / Conversion failed) because MediaMTX ICE
advertised 127.0.0.1. Encoder VMAF tee crashes WHIP. MoQ never played because
the player waited for preview_ready and missed catalog group 0. MPEG-TS
chased a ~1.5s live window with stash off and stalled on WAN HTTP-TS.
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import DestinationProfile  # noqa: E402
from encoder_capture import build_tee_output_args  # noqa: E402
from moq_publish import mediamtx_loopback_publish_url  # noqa: E402
from upload_service import UploadJob, UploadService  # noqa: E402


class MediaMtxIceConfigTests(unittest.TestCase):
    def test_ice_does_not_advertise_interface_ips(self) -> None:
        text = (ROOT / "infra" / "mediamtx" / "mediamtx.yml").read_text()
        self.assertIn("webrtcIPsFromInterfaces: no", text)
        self.assertNotIn("webrtcIPsFromInterfaces: yes", text)

    def test_install_script_pins_interface_ips_off(self) -> None:
        text = (ROOT / "infra" / "mediamtx" / "scripts" / "install-mediamtx.sh").read_text()
        self.assertIn('lines.append("webrtcIPsFromInterfaces: no")', text)


class WhipEncoderVmafTests(unittest.TestCase):
    def test_tee_rejects_webrtc(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            build_tee_output_args("webrtc", "http://203.0.113.10:8889/benchmark/whip", "/tmp/x.ts")
        self.assertIn("webrtc", str(ctx.exception).lower())

    @patch("upload_service.ffmpeg_has_whip_muxer", return_value=True)
    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_direct_ffmpeg_skips_capture_tee_for_webrtc_vmaf(self, _ffmpeg, _whip) -> None:
        job = UploadJob(
            media_path="/tmp/x.mp4",
            destination=DestinationProfile(
                protocol="webrtc",
                url="http://35.196.97.22:8889/benchmark/whip",
                preset_id="moq_mediamtx_gcp_east_whip",
                ingest_provider="gcp_east_mediamtx",
            ),
            duration_sec=5,
            compute_vmaf_encoder=True,
            job_id="whip-vmaf",
        )
        recorded: list[list[str]] = []

        def fake_popen(cmd, **_kwargs):
            recorded.append(list(cmd))
            raise FileNotFoundError

        with patch("upload_service.subprocess.Popen", side_effect=fake_popen):
            result = UploadService()._run_direct_ffmpeg(job)
        self.assertFalse(result.success)
        self.assertEqual(job.encoder_capture_path, "")
        self.assertTrue(recorded)
        joined = " ".join(recorded[0])
        self.assertNotIn("tee", recorded[0])
        self.assertIn("whip", joined.lower())


class FfmpegFailureMessageTests(unittest.TestCase):
    def test_includes_more_than_generic_conversion_failed(self) -> None:
        process = MagicMock()
        process.returncode = 69
        process.stderr = MagicMock()
        process.stderr.read.return_value = (
            b"Error submitting a packet to the muxer: Immediate exit requested\n"
            b"Error muxing a packet\n"
            b"Conversion failed!\n"
        )
        message = UploadService()._ffmpeg_failure_message(process)
        self.assertIn("69", message)
        self.assertIn("Immediate exit requested", message)
        self.assertIn("Conversion failed", message)


class EastWhipLoopbackTests(unittest.TestCase):
    def test_east_whip_is_not_rewritten_to_central_loopback(self) -> None:
        with patch.dict(os.environ, {"MEDIAMTX_LOOPBACK_PUBLISH": "1"}, clear=False):
            url = "http://35.196.97.22:8889/benchmark/whip"
            self.assertEqual(mediamtx_loopback_publish_url(url), url)

    def test_east_whip_job_is_remote_mediamtx(self) -> None:
        job = UploadJob(
            media_path="/tmp/x.mp4",
            destination=DestinationProfile(
                protocol="webrtc",
                url="http://35.196.97.22:8889/benchmark/whip",
                preset_id="moq_mediamtx_gcp_east_whip",
                ingest_provider="gcp_east_mediamtx",
            ),
            duration_sec=5,
            job_id="east-whip",
        )
        self.assertTrue(UploadService()._is_remote_mediamtx_publish(job))


class FrontendRegressionSourceTests(unittest.TestCase):
    def test_moq_playback_gate_does_not_wait_for_preview(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "playbackGate.ts").read_text()
        self.assertIn("protocol !== \"moq\" && protocol !== \"webrtc\"", text)
        self.assertIn("preview_ready === false", text)

    def test_moq_player_retries_catalog_miss(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "players" / "MoqPlayer.tsx").read_text()
        self.assertIn("const MAX_CONNECT_ATTEMPTS = 12", text)
        self.assertIn("const CATALOG_RETRY_MS = 4_000", text)
        self.assertIn("catalog_timeout_retry", text)
        self.assertIn("subscribe_0x10_keepalive", text)
        self.assertIn("noMediaTimeoutMs", text)

    def test_harness_does_not_wait_for_moq_preview_ready(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "HarnessPage.tsx").read_text()
        self.assertNotIn("waiting for MoQ preview_ready", text)

    def test_stream_player_does_not_invent_benchmark_namespace(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "StreamPlayer.tsx").read_text()
        self.assertIn("const moqReadyNamespace = (moqNamespace || \"\").trim();", text)
        self.assertNotIn("target.moqNamespace || moqNamespace", text)

    def test_mpegts_enables_stash_for_wan(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "players" / "MpegTsPlayer.tsx").read_text()
        self.assertIn("enableStashBuffer: true", text)
        self.assertIn("liveBufferLatencyMaxLatency: 3.5", text)
        self.assertNotIn("enableStashBuffer: false", text)

    def test_ui_does_not_request_encoder_vmaf_for_webrtc(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "App.tsx").read_text()
        self.assertIn("endpoint.protocol !== \"webrtc\"", text)


if __name__ == "__main__":
    unittest.main()
