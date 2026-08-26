"""RTMP join-path regressions from the 2026-08-22 Linode Zixi run (TTFF ~23s).

Four things stacked into that number: a 2s GOP floor inherited from
hls_chunk_time, a 2.5s HTTP-TS probe timeout serialized with a 0.5s poll, a 2s
sleep before the Zixi input-recreate retry, and a player that skipped its
sync-byte probe exactly when the origin was most likely still empty.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from encode_profile import (  # noqa: E402
    ASSUMED_FPS,
    delivery_gop_frames,
    encode_profile_summary,
    gop_frames_for_latency,
    hls_segment_sec,
)


class DeliveryGopTests(unittest.TestCase):
    def test_default_target_gets_one_second_idrs(self):
        # 2s chunk, 1s GOP: halves the first-IDR wait on HTTP-TS.
        self.assertEqual(delivery_gop_frames(2000), ASSUMED_FPS)
        self.assertEqual(delivery_gop_frames(5000), ASSUMED_FPS)

    def test_gop_divides_the_hls_chunk_exactly(self):
        """A GOP only has to divide the chunk, not equal it. If it does not,
        Zixi stretches segments to the next IDR and the player's 2-segment
        buffer doubles the damage (the 16.7s e2e regression of 2026-07-21)."""
        for target_ms in (800, 2000, 4000, 5000, 6000, 8000, 10_000):
            segment = hls_segment_sec(target_ms)
            gop_sec = delivery_gop_frames(target_ms) / ASSUMED_FPS
            self.assertAlmostEqual(
                (segment / gop_sec) % 1.0,
                0.0,
                places=6,
                msg=f"target={target_ms}ms segment={segment}s gop={gop_sec}s",
            )

    def test_never_exceeds_the_segment(self):
        for target_ms in (800, 2000, 6000, 10_000):
            self.assertLessEqual(
                delivery_gop_frames(target_ms) / ASSUMED_FPS,
                float(hls_segment_sec(target_ms)),
            )

    def test_chunk_sized_gop_mapping_is_still_available_unchanged(self):
        # gop_frames_for_latency stays the documented chunk-aligned mapping;
        # delivery_gop_frames is what publish paths actually use.
        self.assertEqual(gop_frames_for_latency(2000), 60)
        self.assertEqual(encode_profile_summary("720p", 2000)["delivery_gop_frames"], 30)


class ZixiPublishGopTests(unittest.TestCase):
    def test_rtmp_zixi_publish_uses_one_second_idrs(self):
        from destinations import DestinationProfile
        from upload_service import UploadJob

        job = UploadJob(
            media_path="clip.mp4",
            destination=DestinationProfile(
                protocol="rtmp",
                url="rtmp://45.79.177.85:1935/live/benchmark",
                preset_id="moq_zixi_linode_rtmp",
                ingest_provider="zixi",
            ),
            duration_sec=30,
            job_id="t",
            target_latency_ms=2000,
        )
        cmd = job.ffmpeg_cmd
        self.assertEqual(cmd[cmd.index("-g") + 1], str(ASSUMED_FPS))
        self.assertEqual(cmd[cmd.index("-keyint_min") + 1], str(ASSUMED_FPS))


class JoinPathTimingTests(unittest.TestCase):
    """These are wall-clock costs on the join path, so they are pinned."""

    def _upload_service_source(self) -> str:
        return (ROOT / "src" / "upload_service.py").read_text()

    def test_http_ts_preview_probe_is_subsecond_capable(self):
        source = self._upload_service_source()
        match = re.search(
            r"ts_ok = probe_http_ts_ready\(.*?timeout=([\d.]+),",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "preview HTTP-TS probe timeout not found")
        self.assertLessEqual(float(match.group(1)), 1.5)

    def test_preview_poll_is_tight_before_the_gate_opens(self):
        source = self._upload_service_source()
        self.assertIn("stop_event.wait(0.5 if notified else 0.2)", source)

    def test_rtmp_retry_backoff_is_not_two_seconds(self):
        source = self._upload_service_source()
        match = re.search(
            r"retrying connect.*?time\.sleep\(([\d.]+)\)",
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(match, "RTMP early-exit retry sleep not found")
        self.assertLessEqual(float(match.group(1)), 1.0)


class PlayerConnectProbeTests(unittest.TestCase):
    def test_probe_is_skipped_on_preview_ready_not_on_gate(self):
        """RTMP/SRT get gate=live while preview_ready is still false, so keying
        the skip off the gate disabled the sync-byte check exactly when the
        origin was most likely empty — mpegts.js then burned 1.2s reconnects."""
        source = (
            ROOT / "web" / "frontend" / "src" / "StreamPlayer.tsx"
        ).read_text()
        self.assertIn("skipConnectProbe={previewReady === true}", source)
        self.assertNotIn('skipConnectProbe={playbackGate === "live"}', source)


if __name__ == "__main__":
    unittest.main()
