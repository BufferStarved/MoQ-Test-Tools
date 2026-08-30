"""Recorder track selection for browser LOC vs cloud CMAF."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ingest_agent"))

from recording_service import _docker_record_cmd, _recorder_tracks, recording_has_media  # noqa: E402


class RecorderTrackTests(unittest.TestCase):
    def test_default_tries_loc_then_cmaf(self) -> None:
        self.assertEqual(_recorder_tracks(""), ["video", "vide_1"])

    def test_browser_uses_loc_video(self) -> None:
        self.assertEqual(_recorder_tracks("video"), ["video"])

    def test_cloud_uses_cmaf_vide_1(self) -> None:
        self.assertEqual(_recorder_tracks("vide_1"), ["vide_1"])

    def test_docker_cmd_bind_mounts_host_record_script(self) -> None:
        recorder = ROOT / "tools" / "openmoq-recorder" / "bin" / "openmoq-fmp4-record"
        with patch("recording_service.shutil.which", return_value="/usr/bin/docker"):
            with patch("recording_service._resolve_recorder_bin", return_value=str(recorder)):
                cmd = _docker_record_cmd(
                    relay="https://example:4433/moq-relay",
                    namespace="live/demo",
                    output_path=Path("/tmp/job.mp4"),
                    duration_sec=80,
                    tracks=["video"],
                    cert_sha256="abc",
                )
        self.assertIsNotNone(cmd)
        assert cmd is not None
        joined = " ".join(cmd)
        self.assertIn("record.mjs:/app/tools/openmoq-recorder/record.mjs:ro", joined)
        self.assertIn("record-policy.mjs:/app/tools/openmoq-recorder/record-policy.mjs:ro", joined)
        wrapper = (ROOT / "tools/openmoq-recorder/bin/openmoq-fmp4-record-docker").read_text()
        self.assertIn(
            "record-policy.mjs:/app/tools/openmoq-recorder/record-policy.mjs:ro",
            wrapper,
        )
        self.assertIn("MOQ_RELAY_CERT_SHA256=abc", joined)
        self.assertIn("--track video", joined)
        self.assertNotIn("--track vide_1", joined)

    def test_docker_cmd_omits_empty_cert_pin(self) -> None:
        recorder = ROOT / "tools" / "openmoq-recorder" / "bin" / "openmoq-fmp4-record"
        with patch("recording_service.shutil.which", return_value="/usr/bin/docker"):
            with patch("recording_service._resolve_recorder_bin", return_value=str(recorder)):
                cmd = _docker_record_cmd(
                    relay="https://66-228-49-113.sslip.io:14433/moq-relay",
                    namespace="bench-demo",
                    output_path=Path("/tmp/job.mp4"),
                    duration_sec=80,
                    tracks=["vide_1"],
                    cert_sha256="",
                )
        self.assertIsNotNone(cmd)
        assert cmd is not None
        self.assertNotIn("MOQ_RELAY_CERT_SHA256", " ".join(cmd))

    def test_recording_has_media_ignores_tiny_or_missing(self) -> None:
        missing = Path("/tmp/moq-recorder-missing-test.mp4")
        self.assertFalse(recording_has_media(missing))
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
            path = Path(handle.name)
            handle.write(b"x" * 32)
        self.addCleanup(path.unlink)
        self.assertFalse(recording_has_media(path))
        path.write_bytes(b"x" * 512)
        self.assertTrue(recording_has_media(path))


if __name__ == "__main__":
    unittest.main()
