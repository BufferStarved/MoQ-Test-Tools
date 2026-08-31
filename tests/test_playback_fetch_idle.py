""" /api/playback/fetch must tell 200-no-body idle HTTP-TS from host-down. """

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

os.environ.setdefault("LOCAL_PUBLISHER_ENABLED", "0")

import main as api_main  # noqa: E402


class PlaybackFetchIdleHelpersTests(unittest.TestCase):
    def test_int64_max_content_length_is_unbounded(self) -> None:
        self.assertTrue(api_main._content_length_is_unbounded("9223372036854775807"))
        self.assertTrue(api_main._content_length_is_unbounded(None))
        self.assertTrue(api_main._content_length_is_unbounded(""))
        self.assertFalse(api_main._content_length_is_unbounded("1880"))

    def test_zixi_named_http_ts_is_live(self) -> None:
        self.assertTrue(
            api_main.is_live_http_ts(
                "/benchmark.ts",
                {
                    "Content-Type": "video/mp2t",
                    "Content-Length": "9223372036854775807",
                },
            )
        )
        self.assertTrue(
            api_main.is_live_http_ts(
                "/SRT%20Test%20EC.ts",
                {"Content-Type": "video/mp2t", "Cache-Control": "no-cache"},
            )
        )

    def test_finite_hls_ts_segment_is_not_live_http_ts(self) -> None:
        self.assertFalse(
            api_main.is_live_http_ts(
                "/hls/stream/seg001.ts",
                {"Content-Type": "video/mp2t", "Content-Length": "188000"},
            )
        )

    def test_idle_response_is_distinct_from_host_down_504(self) -> None:
        idle = api_main.playback_fetch_idle_response(200)
        self.assertEqual(idle.status_code, 504)
        self.assertEqual(idle.headers["X-Playback-Upstream-Status"], "200")
        self.assertEqual(idle.headers["X-Playback-First-Byte"], "idle")
        body = json.loads(idle.body)
        self.assertIn("answered HTTP 200 but sent no media", body["detail"])
        self.assertNotEqual(body["detail"], api_main.PLAYBACK_FETCH_TIMED_OUT)


if __name__ == "__main__":
    unittest.main()
