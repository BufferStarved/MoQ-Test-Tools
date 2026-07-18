"""Ensure managed Zixi SRT ffmpeg cmds include -output_ts_offset."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import DestinationProfile  # noqa: E402
from upload_service import UploadJob  # noqa: E402


class ZixiUploadTsOffsetWiringTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        os.environ["ZIXI_TS_OFFSET_STATE"] = str(Path(self._tmpdir.name) / "off.json")
        os.environ["ZIXI_OUTPUT_TS_OFFSET"] = "1"
        os.environ["ZIXI_TS_OFFSET_STEP_FLOOR"] = "300"

    def tearDown(self):
        self._tmpdir.cleanup()
        for key in ("ZIXI_TS_OFFSET_STATE", "ZIXI_OUTPUT_TS_OFFSET", "ZIXI_TS_OFFSET_STEP_FLOOR"):
            os.environ.pop(key, None)

    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_managed_zixi_srt_cmd_has_offset(self, _ffmpeg):
        dest = DestinationProfile(
            protocol="srt",
            url="srt://35.222.33.58:10080?mode=caller&latency=200000",
            preset_id="moq_zixi_gcp",
        )
        job1 = UploadJob(media_path="/tmp/dummy.mp4", destination=dest, duration_sec=60)
        cmd1 = job1._build_ffmpeg_cmd(udp_url="udp://127.0.0.1:9?pkt_size=1316")
        # First publish may start at timeline 0 (flag omitted when offset is 0).
        self.assertNotIn("-output_ts_offset", cmd1)

        job2 = UploadJob(media_path="/tmp/dummy.mp4", destination=dest, duration_sec=60)
        cmd2 = job2._build_ffmpeg_cmd(udp_url="udp://127.0.0.1:9?pkt_size=1316")
        self.assertIn("-output_ts_offset", cmd2)
        self.assertEqual(cmd2[cmd2.index("-output_ts_offset") + 1], "300")
        # Same job rebuild must not allocate again.
        cmd2b = job2._build_ffmpeg_cmd(udp_url="udp://127.0.0.1:9?pkt_size=1316")
        self.assertEqual(cmd2b[cmd2b.index("-output_ts_offset") + 1], "300")

    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_mediamtx_srt_has_no_offset(self, _ffmpeg):
        job = UploadJob(
            media_path="/tmp/dummy.mp4",
            destination=DestinationProfile(
                protocol="srt",
                url="srt://34.9.217.178:8890?streamid=publish:benchmark",
                preset_id="moq_mediamtx_gcp_srt",
                ingest_provider="gcp_mediamtx",
            ),
            duration_sec=60,
        )
        cmd = job._build_ffmpeg_cmd(udp_url="udp://127.0.0.1:9?pkt_size=1316")
        self.assertNotIn("-output_ts_offset", cmd)


if __name__ == "__main__":
    unittest.main()
