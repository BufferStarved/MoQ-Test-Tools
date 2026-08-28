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

    def test_ice_udp_listener_address_stays_bindable(self) -> None:
        """webrtcLocalUDPAddress goes straight to net.ListenPacket, so it must
        be an address the host owns. On GCE the public IP lives on the 1:1 NAT,
        never on the NIC — pinning it there fails EADDRNOTAVAIL and MediaMTX
        aborts before its HLS/RTMP/SRT servers start, i.e. a full outage whose
        only symptom is "the site is down". Advertising the public IP is
        webrtcAdditionalHosts' job (an SDP rewrite), not this listener's."""
        text = (ROOT / "infra" / "mediamtx" / "mediamtx.yml").read_text()
        self.assertIn("webrtcLocalUDPAddress: :8189", text)
        self.assertIn('webrtcAdditionalHosts: ["34.9.217.178"]', text)

    def test_install_script_preflights_the_ice_listener(self) -> None:
        """Narrowing the listener is only safe behind a bind check, and a
        rejected address must fail the install loudly instead of leaving the
        host with no HLS/RTMP/SRT."""
        text = (ROOT / "infra" / "mediamtx" / "scripts" / "install-mediamtx.sh").read_text()
        self.assertIn("def bindable(", text)
        self.assertIn("sanitise_ice_udp", text)
        self.assertIn("listener opened", text)
        self.assertIn("MediaMTX did not open its WebRTC listener", text)


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

    def test_rtmp_closed_pipe_is_not_cmaf_stdin(self) -> None:
        process = MagicMock()
        process.returncode = 224
        process.stderr = MagicMock()
        process.stderr.read.return_value = (
            b"[libx264 @ 0x58] frame I:1 Avg QP: 9.29 size: 3417\n"
            b"Error muxing a packet\n"
            b"Error writing trailer: Input/output error\n"
            b"Conversion failed!\n"
        )
        message = UploadService()._ffmpeg_failure_message(process, protocol="rtmp")
        self.assertIn("RTMP publish failed", message)
        self.assertIn("224", message)
        self.assertNotIn("CMAF init", message)
        self.assertNotIn("closed publisher pipe", message)
        self.assertNotIn("frame I:1", message)

    def test_srt_closed_pipe_is_not_cmaf_stdin(self) -> None:
        process = MagicMock()
        process.returncode = 1
        process.stderr = MagicMock()
        process.stderr.read.return_value = (
            b"Error writing trailer: Input/output error\n"
            b"Conversion failed!\n"
        )
        message = UploadService()._ffmpeg_failure_message(process, protocol="srt")
        self.assertIn("SRT publish failed", message)
        self.assertNotIn("CMAF init", message)
        self.assertNotIn("closed publisher pipe", message)

    def test_webrtc_245_mid_run_is_retryable_ingest_drop(self) -> None:
        from upload_service import ingest_session_retry_kind

        self.assertEqual(
            ingest_session_retry_kind(
                protocol="webrtc",
                ran_sec=18.757,
                remaining_sec=11.243,
                early_exit_retries=2,
                mid_run_retries=0,
                cancelled=False,
                error="WHIP publish failed (ffmpeg 245): Conversion failed!",
            ),
            "mid",
        )

    def test_webrtc_245_is_whip_not_cmaf_pipe(self) -> None:
        process = MagicMock()
        process.returncode = 245
        process.stderr = MagicMock()
        process.stderr.read.return_value = (
            b"[out#0/whip @ 0x5fa] video:5920KiB audio:232KiB\n"
            b"Conversion failed!\n"
        )
        message = UploadService()._ffmpeg_failure_message(process, protocol="webrtc")
        self.assertIn("WHIP publish failed", message)
        self.assertIn("245", message)
        self.assertNotIn("closed publisher pipe", message)

    def test_moq_closed_pipe_keeps_cmaf_hint(self) -> None:
        process = MagicMock()
        process.returncode = 224
        process.stderr = MagicMock()
        process.stderr.read.return_value = (
            b"Error writing trailer: Input/output error\n"
            b"Error muxing a packet\n"
            b"Conversion failed!\n"
        )
        message = UploadService()._ffmpeg_failure_message(process, protocol="moq")
        self.assertIn("closed publisher pipe", message)


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
    def test_moq_playback_gate_is_live_before_preview_ready(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "playbackGate.ts").read_text()
        self.assertIn('protocol === "webrtc" && !browser', text)
        self.assertIn("preview_ready === false", text)
        self.assertIn("Subscribe on running + 0x10 keepalive", text)
        self.assertIn('if (protocol === "moq")', text)
        self.assertNotIn("protocol !== \"moq\" && protocol !== \"webrtc\"", text)

    def test_moq_player_retries_catalog_miss(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "players" / "MoqPlayer.tsx").read_text()
        self.assertIn("const MAX_CONNECT_ATTEMPTS = 12", text)
        self.assertIn("const CATALOG_RETRY_MS = 4_000", text)
        self.assertIn("catalog_timeout_retry", text)
        self.assertIn("catalog_timeout_skipped waiting_for_announce", text)
        self.assertIn("catalog_timeout_skipped encode_running", text)
        self.assertIn("subscribe_0x10_keepalive", text)
        self.assertIn("noMediaTimeoutMs", text)

    def test_harness_does_not_wait_for_moq_preview_ready(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "HarnessPage.tsx").read_text()
        self.assertNotIn("waiting for MoQ preview_ready", text)
        self.assertIn("defaultPlaybackModeForProtocol", text)
        self.assertNotIn('job.protocol === "webrtc" ? "whep" : "hls"', text)

    def test_stream_player_does_not_invent_benchmark_namespace(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "StreamPlayer.tsx").read_text()
        self.assertIn("const moqReadyNamespace = (moqNamespace || \"\").trim();", text)
        self.assertNotIn("target.moqNamespace || moqNamespace", text)

    def test_srt_preview_opens_on_http_ts_not_hls(self) -> None:
        text = (ROOT / "src" / "upload_service.py").read_text()
        self.assertIn("HTTP-TS preview ready for job", text)
        self.assertIn("skip HLS gate", text)

    def test_mpegts_enables_stash_for_wan(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "players" / "MpegTsPlayer.tsx").read_text()
        self.assertIn("enableStashBuffer: true", text)
        self.assertIn("liveBufferLatencyMaxLatency: 1.5", text)
        self.assertIn("seekNearLiveEdge", text)
        self.assertNotIn("enableStashBuffer: false", text)

    def test_ui_does_not_request_encoder_vmaf_for_webrtc(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "App.tsx").read_text()
        self.assertIn("endpoint.protocol !== \"webrtc\"", text)


if __name__ == "__main__":
    unittest.main()
