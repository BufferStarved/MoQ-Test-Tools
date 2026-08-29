"""Shared comparison encode: one x264, copy remux per dest."""

from __future__ import annotations

import io
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from comparison_encode_hub import (  # noqa: E402
    ComparisonEncodeHub,
    job_can_join_shared_encode,
    shared_encode_reader_url,
)
from destinations import DestinationProfile  # noqa: E402
from moq_publish import (  # noqa: E402
    SHARED_ENCODE_QUERY,
    build_ffmpeg_moq_cmd,
    is_shared_encode_udp,
)
from upload_service import UploadJob  # noqa: E402


class _FakeMaster:
    def __init__(self, payload: bytes = b"\x47" * 188) -> None:
        self.stdout = io.BytesIO(payload * 8)
        self._code = None

    def poll(self):
        return self._code

    def terminate(self):
        self._code = 0

    def kill(self):
        self._code = 0

    def wait(self, timeout=None):
        self._code = 0
        return 0


class SharedEncodeUrlTests(unittest.TestCase):
    def test_marks_hub_udp_and_not_plain_udp(self):
        url = shared_encode_reader_url(41234)
        self.assertTrue(is_shared_encode_udp(url))
        self.assertIn(SHARED_ENCODE_QUERY, url)
        self.assertFalse(is_shared_encode_udp("udp://127.0.0.1:19001?fifo_size=1000000"))
        self.assertFalse(is_shared_encode_udp("/opt/moq-test-tools/uploads/bbb.mp4"))


class JoinGateTests(unittest.TestCase):
    def test_cloud_file_comparison_joins(self):
        job = SimpleNamespace(
            publisher_host="cloud",
            encoder="ffmpeg",
            comparison_id="cmp-1",
            media_path="/tmp/bbb.mp4",
        )
        self.assertTrue(job_can_join_shared_encode(job))

    def test_browser_local_live_and_solo_skip(self):
        base = dict(encoder="ffmpeg", comparison_id="cmp-1", media_path="/tmp/bbb.mp4")
        self.assertFalse(
            job_can_join_shared_encode(SimpleNamespace(publisher_host="browser", **base))
        )
        self.assertFalse(
            job_can_join_shared_encode(SimpleNamespace(publisher_host="local", **base))
        )
        self.assertFalse(
            job_can_join_shared_encode(
                SimpleNamespace(
                    publisher_host="cloud",
                    encoder="ffmpeg",
                    comparison_id="cmp-1",
                    media_path="udp://127.0.0.1:9?fifo_size=1",
                )
            )
        )
        self.assertFalse(
            job_can_join_shared_encode(
                SimpleNamespace(
                    publisher_host="cloud",
                    encoder="ffmpeg",
                    comparison_id="",
                    media_path="/tmp/bbb.mp4",
                )
            )
        )


class HubAttachTests(unittest.TestCase):
    def test_two_legs_share_one_master_and_detach_stops_it(self):
        started = []

        def fake_popen(cmd, **_kwargs):
            started.append(cmd)
            return _FakeMaster()

        hub = ComparisonEncodeHub(popen=fake_popen, find_bin=lambda: "ffmpeg")
        a = SimpleNamespace(
            job_id="a",
            comparison_id="cmp-hub",
            media_path="/tmp/bbb.mp4",
            encode_ladder="720p",
            target_latency_ms=2000,
            duration_sec=20,
        )
        b = SimpleNamespace(
            job_id="b",
            comparison_id="cmp-hub",
            media_path="/tmp/bbb.mp4",
            encode_ladder="720p",
            target_latency_ms=2000,
            duration_sec=20,
        )
        url_a = hub.attach(a)
        url_b = hub.attach(b)
        self.assertTrue(is_shared_encode_udp(url_a))
        self.assertTrue(is_shared_encode_udp(url_b))
        self.assertNotEqual(url_a, url_b)
        self.assertEqual(len(started), 1)
        self.assertEqual(hub.reader_count(a), 2)
        a.media_path = url_a
        b.media_path = url_b
        hub.detach(a)
        self.assertEqual(hub.reader_count(b), 1)
        hub.detach(b)
        self.assertEqual(hub.reader_count(b), 0)
        time.sleep(0.05)
        self.assertEqual(len(started), 1)


class CopyRemuxTests(unittest.TestCase):
    @patch("upload_service.find_ffmpeg", return_value="ffmpeg")
    def test_srt_and_rtmp_copy_shared_master(self, _ffmpeg):
        url = shared_encode_reader_url(41999)
        for protocol, dest_url, preset, provider in (
            (
                "srt",
                "srt://34.9.217.178:8890?streamid=publish:benchmark",
                "moq_mediamtx_gcp_srt",
                "gcp_mediamtx",
            ),
            (
                "rtmp",
                "rtmp://45.33.68.151:1935/live/benchmark",
                "moq_zixi_linode_rtmp",
                "zixi",
            ),
        ):
            job = UploadJob(
                media_path=url,
                destination=DestinationProfile(
                    protocol=protocol,
                    url=dest_url,
                    preset_id=preset,
                    ingest_provider=provider,
                ),
                duration_sec=20,
            )
            self.assertIn("-c:v", job.ffmpeg_cmd)
            self.assertEqual(job.ffmpeg_cmd[job.ffmpeg_cmd.index("-c:v") + 1], "copy")
            self.assertNotIn("libx264", job.ffmpeg_cmd)

    def test_moq_cmd_copies_shared_master(self):
        url = shared_encode_reader_url(41998)
        with patch("moq_publish.find_ffmpeg", return_value="ffmpeg"):
            cmd = build_ffmpeg_moq_cmd(url, progress_path="pipe:1", duration_sec=20)
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "copy")
        self.assertNotIn("libx264", cmd)


if __name__ == "__main__":
    unittest.main()
