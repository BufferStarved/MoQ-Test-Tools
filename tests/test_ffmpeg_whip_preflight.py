"""Fail closed when the encode host ffmpeg cannot mux WHIP."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

from moq_publish import ffmpeg_has_whip_muxer, whip_ffmpeg_missing_error
from publisher_agent.deps import check_ffmpeg_whip
from publisher_agent.deps import DepStatus


class FfmpegWhipMuxerTests(unittest.TestCase):
    def test_detects_listed_whip_muxer(self) -> None:
        muxers = " File formats:\n  E mp4             MP4 (MPEG-4 Part 14)\n  E whip            WHIP(WebRTC-HTTP ingestion protocol) muxer\n"
        with mock.patch("moq_publish.subprocess.run") as run:
            run.return_value = mock.Mock(stdout=muxers, stderr="")
            self.assertTrue(ffmpeg_has_whip_muxer("/opt/homebrew/bin/ffmpeg"))

    def test_ignores_unrelated_whip_text(self) -> None:
        muxers = "  E mp4             MP4\nSome docs mention whip:// URLs but this build has no muxer\n"
        with mock.patch("moq_publish.subprocess.run") as run:
            run.return_value = mock.Mock(stdout=muxers, stderr="")
            self.assertFalse(ffmpeg_has_whip_muxer("/usr/bin/ffmpeg"))

    def test_error_names_the_binary(self) -> None:
        text = whip_ffmpeg_missing_error("/opt/homebrew/bin/ffmpeg")
        self.assertIn("/opt/homebrew/bin/ffmpeg", text)
        self.assertIn("WHIP muxer", text)
        self.assertIn("run-local-publisher.sh", text)


class DirectWhipJobPreflightTests(unittest.TestCase):
    def test_webrtc_job_fails_before_ffmpeg_234(self) -> None:
        from destinations import DestinationProfile
        from upload_service import UploadJob, UploadService

        job = UploadJob(
            media_path="dummy.mp4",
            destination=DestinationProfile(
                protocol="webrtc",
                url="http://34.9.217.178:8889/benchmark/whip",
                preset_id="moq_mediamtx_gcp_whip",
                ingest_provider="gcp_mediamtx",
            ),
            duration_sec=8,
            job_id="whip-no-muxer",
        )
        with mock.patch("upload_service.find_ffmpeg", return_value="/opt/homebrew/bin/ffmpeg"):
            with mock.patch("upload_service.ffmpeg_has_whip_muxer", return_value=False):
                result = UploadService()._run_direct_ffmpeg(job)
        self.assertFalse(result.success)
        self.assertIn("WHIP muxer", result.error or "")
        self.assertNotIn("exited with code 234", result.error or "")


class HubWhipCapabilityTests(unittest.TestCase):
    def test_fail_closed_without_signal(self) -> None:
        from publisher_hub import capabilities_allow_whip

        self.assertFalse(capabilities_allow_whip({}))
        self.assertFalse(capabilities_allow_whip({"ready": True, "deps": []}))

    def test_reads_ffmpeg_whip_flag(self) -> None:
        from publisher_hub import capabilities_allow_whip

        self.assertTrue(capabilities_allow_whip({"ffmpeg_whip": True}))
        self.assertFalse(capabilities_allow_whip({"ffmpeg_whip": False}))

    def test_reads_ffmpeg_whip_dep(self) -> None:
        from publisher_hub import capabilities_allow_whip

        self.assertTrue(
            capabilities_allow_whip({"deps": [{"name": "ffmpeg-whip", "ok": True}]})
        )


class RequiredOkTests(unittest.TestCase):
    def test_requires_whip_dep(self) -> None:
        from publisher_agent.deps import DepStatus, required_ok

        ffmpeg = DepStatus(name="ffmpeg", ok=True, path="/opt/homebrew/bin/ffmpeg")
        whip = DepStatus(name="ffmpeg-whip", ok=False, path="/opt/homebrew/bin/ffmpeg")
        self.assertFalse(required_ok([ffmpeg, whip]))
        self.assertTrue(required_ok([ffmpeg, DepStatus(name="ffmpeg-whip", ok=True, path=ffmpeg.path)]))


class AgentWhipDepTests(unittest.TestCase):
    def test_ffmpeg_whip_miss_when_muxer_absent(self) -> None:
        ffmpeg = DepStatus(name="ffmpeg", ok=True, path="/opt/homebrew/bin/ffmpeg", detail="libx264 ok")
        with mock.patch(
            "publisher_agent.deps._ffmpeg_feature_probe",
            return_value=(True, True, False, ""),
        ):
            whip = check_ffmpeg_whip(ffmpeg)
        self.assertFalse(whip.ok)
        self.assertIn("whip", whip.detail.lower())


if __name__ == "__main__":
    unittest.main()
