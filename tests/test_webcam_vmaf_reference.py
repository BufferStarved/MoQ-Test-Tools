"""Encoder VMAF for live webcam sources: per-job stream-copied reference.

A live bridge source (udp://) has no file to score against — the encode
ffmpeg stream-copies the exact input it consumed to vmaf_reference.ts, so
reference and distorted share the same first decodable frame and cadence.
Device webcams (raw video input) must NOT get the copy output (rawvideo
cannot be muxed into MPEG-TS).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import DestinationProfile  # noqa: E402
from moq_publish import build_ffmpeg_moq_cmd  # noqa: E402
from upload_service import UploadJob  # noqa: E402


def _mediamtx_srt_dest() -> DestinationProfile:
    return DestinationProfile(
        protocol="srt",
        url="srt://34.9.217.178:8890?streamid=publish:benchmark",
        preset_id="moq_mediamtx_gcp_srt",
        ingest_provider="gcp_mediamtx",
    )


class WebcamVmafReferenceTests(unittest.TestCase):
    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_live_udp_source_with_capture_gets_reference_output(self, _ffmpeg):
        job = UploadJob(
            media_path="udp://127.0.0.1:19001?fifo_size=1000000",
            destination=_mediamtx_srt_dest(),
            duration_sec=60,
        )
        cmd = job._build_ffmpeg_cmd(capture_path="/tmp/moq-bench-x/encoder_capture.ts")
        self.assertTrue(job.vmaf_reference_capture_path.endswith("vmaf_reference.ts"))
        self.assertIn(job.vmaf_reference_capture_path, cmd)
        # Reference output is a stream copy appended after the tee output.
        ref_index = cmd.index(job.vmaf_reference_capture_path)
        self.assertEqual(cmd[ref_index - 2 : ref_index], ["-f", "mpegts"])
        self.assertIn("copy", cmd[ref_index - 6 : ref_index])
        tee_index = cmd.index("tee")
        self.assertLess(tee_index, ref_index)

    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_vod_file_source_gets_no_reference_output(self, _ffmpeg):
        job = UploadJob(
            media_path="/tmp/clip.mp4",
            destination=_mediamtx_srt_dest(),
            duration_sec=60,
        )
        cmd = job._build_ffmpeg_cmd(capture_path="/tmp/moq-bench-x/encoder_capture.ts")
        self.assertEqual(job.vmaf_reference_capture_path, "")
        self.assertNotIn("vmaf_reference.ts", " ".join(cmd))

    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_device_webcam_gets_no_reference_output(self, _ffmpeg):
        """Raw device input can't be stream-copied into MPEG-TS."""
        job = UploadJob(
            media_path="device:webcam",
            destination=_mediamtx_srt_dest(),
            duration_sec=60,
        )
        cmd = job._build_ffmpeg_cmd(capture_path="/tmp/moq-bench-x/encoder_capture.ts")
        self.assertEqual(job.vmaf_reference_capture_path, "")
        self.assertNotIn("vmaf_reference.ts", " ".join(cmd))

    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_no_capture_means_no_reference(self, _ffmpeg):
        job = UploadJob(
            media_path="udp://127.0.0.1:19001?fifo_size=1000000",
            destination=_mediamtx_srt_dest(),
            duration_sec=60,
        )
        cmd = job._build_ffmpeg_cmd()
        self.assertEqual(job.vmaf_reference_capture_path, "")
        self.assertNotIn("vmaf_reference.ts", " ".join(cmd))

    def test_moq_cmd_appends_reference_output_when_requested(self):
        cmd = build_ffmpeg_moq_cmd(
            "udp://127.0.0.1:19002?fifo_size=1000000",
            progress_path="/tmp/progress.txt",
            duration_sec=60,
            vmaf_reference_path="/tmp/moq-bench-x/vmaf_reference.ts",
        )
        self.assertIn("/tmp/moq-bench-x/vmaf_reference.ts", cmd)
        # Primary fMP4 pipe output must still precede the reference output.
        self.assertLess(cmd.index("pipe:1"), cmd.index("/tmp/moq-bench-x/vmaf_reference.ts"))

    def test_moq_cmd_without_reference_is_unchanged(self):
        cmd = build_ffmpeg_moq_cmd(
            "udp://127.0.0.1:19002?fifo_size=1000000",
            progress_path="/tmp/progress.txt",
            duration_sec=60,
        )
        self.assertEqual(cmd[-1], "pipe:1")


if __name__ == "__main__":
    unittest.main()
