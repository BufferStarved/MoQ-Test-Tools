"""Regression: MoQ webcam runs must gate playback until the relay confirms a
namespace publish, same as Zixi/MediaMTX gate on a readable HLS segment.

Without this, MoqPlayer started subscribing the instant job.status flipped to
"running" — before openmoq-publisher had any chance to register the namespace
on a live webcam source (browser record -> WS -> bridge ffmpeg -> UDP tee ->
per-destination encode -> publisher). That produced a near-guaranteed
"no such namespace or track" refusal, a fixed multi-second retry wait, and —
because MoQ has no reliable catch-up without LOC CaptureTimestamps — a
permanent latency floor for the rest of the session (2026-07-19/20 webcam QA).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

from job_manager import needs_publish_preview  # noqa: E402


class NeedsPublishPreviewTests(unittest.TestCase):
    def test_moq_always_needs_preview_gate(self):
        self.assertTrue(needs_publish_preview("moq"))
        self.assertTrue(needs_publish_preview("moq", zixi_stream_id="", ingest_provider=""))

    def test_zixi_srt_needs_preview_gate(self):
        self.assertTrue(needs_publish_preview("srt", zixi_stream_id="SRT Test"))

    def test_mediamtx_needs_preview_gate(self):
        self.assertTrue(needs_publish_preview("srt", ingest_provider="gcp_mediamtx"))
        self.assertTrue(needs_publish_preview("rtmp", ingest_provider="gcp_mediamtx"))

    def test_plain_rtmp_and_http_do_not_gate(self):
        self.assertFalse(needs_publish_preview("rtmp"))
        self.assertFalse(needs_publish_preview("http"))
        self.assertFalse(needs_publish_preview("dash"))

    def test_zixi_rtmp_with_stream_id_gates(self):
        self.assertTrue(needs_publish_preview("rtmp", zixi_stream_id="benchmark"))

    def test_srt_without_zixi_or_mediamtx_does_not_gate(self):
        # e.g. a plain UDP-fed SRT preset with no managed Zixi input.
        self.assertFalse(needs_publish_preview("srt"))


if __name__ == "__main__":
    unittest.main()
