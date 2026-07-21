"""MoQ GOP sizing must stay decoupled from the shared HLS-oriented mapping.

openmoq maps one CMAF fragment (one GOP with -movflags frag_keyframe) to one
MoQ group/object, and the player joins on NextGroupStart with no rate
catch-up. The GOP is therefore paid twice in glass-to-glass latency:
fragment accumulation (+1 GOP) and join offset (+0..1 GOP) that persists all
session. The shared gop_frames_for_latency() sizes the GOP to the *whole*
latency budget for Zixi HLS IDR alignment — used for MoQ that produced 4-5s
GOPs / ~1.9MB objects and a real latency of 9-11s against a 4-5s target
(relay logs, 2026-07-20).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from encode_profile import (  # noqa: E402
    ASSUMED_FPS,
    gop_frames_for_latency,
    moq_gop_frames_for_latency,
)
from moq_publish import build_ffmpeg_moq_cmd  # noqa: E402


class MoqGopLatencyTests(unittest.TestCase):
    def test_worst_case_join_latency_fits_target(self):
        """2 x GOP (fragment accumulation + max join offset) must not exceed
        the latency target for any target where that is physically possible
        (>= 2 x the 0.5s GOP floor)."""
        for target_ms in (1000, 2000, 3000, 4000, 5000, 8000, 10_000):
            gop_sec = moq_gop_frames_for_latency(target_ms) / ASSUMED_FPS
            self.assertLessEqual(
                2 * gop_sec * 1000,
                target_ms,
                f"target={target_ms}ms gop={gop_sec}s",
            )

    def test_shared_hls_gop_tracks_segment_duration_not_latency_budget(self):
        """The shared mapping keys the GOP to the HLS segment duration —
        packagers cut segments on IDRs, so a latency-budget-sized GOP
        silently stretched every segment (4s target -> 4s chunks -> 8s
        player buffer -> 16.7s measured glass-to-glass, 2026-07-21)."""
        self.assertEqual(gop_frames_for_latency(4000), 60)   # 2s segment
        self.assertEqual(gop_frames_for_latency(800), 60)    # 2s floor
        self.assertEqual(gop_frames_for_latency(10_000), 150)  # 5s segment
        self.assertEqual(moq_gop_frames_for_latency(4000), 60)

    def test_gop_floor_for_ultra_low_targets(self):
        # 100ms target can't be met by GOP alone; floor at 0.5s for x264 sanity.
        self.assertEqual(moq_gop_frames_for_latency(100), 15)

    def test_gop_cap_for_very_high_targets(self):
        self.assertEqual(moq_gop_frames_for_latency(10_000), 60)

    def test_build_ffmpeg_moq_cmd_uses_moq_gop(self):
        cmd = build_ffmpeg_moq_cmd(
            "clip.mp4",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=4000,
            duration_sec=30,
        )
        g_index = cmd.index("-g")
        self.assertEqual(cmd[g_index + 1], "60")
        keyint_index = cmd.index("-keyint_min")
        self.assertEqual(cmd[keyint_index + 1], "60")


if __name__ == "__main__":
    unittest.main()
