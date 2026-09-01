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
    BROKER_GOP_MS,
    build_video_encode_args,
    gop_frames_for_latency,
    moq_gop_frames_for_latency,
    moq_group_duration_ms,
)
from moq_publish import (  # noqa: E402
    build_ffmpeg_moq_cmd,
    publisher_fragment_drop_count,
    publisher_write_block_error,
    should_reencode_brokered_moq,
)


class MoqGopLatencyTests(unittest.TestCase):
    def test_worst_case_join_latency_fits_target(self):
        """2 x GOP (fragment accumulation + max join offset) must not exceed
        the latency target for any target where that is physically possible
        (>= 2 x the 0.25s GOP floor)."""
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
        # MoQ cadence is capped at 1s — 2s objects arrive in bursts that read
        # as inconsistent playback speed (2026-07-21 webcam run).
        self.assertEqual(moq_gop_frames_for_latency(4000), 30)

    def test_group_duration_splits_brokered_from_solo(self):
        self.assertEqual(moq_group_duration_ms(400, brokered=True), BROKER_GOP_MS)
        self.assertEqual(moq_group_duration_ms(400, brokered=True, dest_count=1), BROKER_GOP_MS)
        self.assertEqual(moq_group_duration_ms(400, brokered=True, dest_count=6), 266.7)
        self.assertEqual(moq_group_duration_ms(400, brokered=False), 266.7)

    def test_gop_floor_for_ultra_low_targets(self):
        # 100ms target can't be met by GOP alone; floor at 0.25s (8 frames @ 30fps).
        self.assertEqual(moq_gop_frames_for_latency(100), 8)

    def test_gop_cap_for_very_high_targets(self):
        self.assertEqual(moq_gop_frames_for_latency(10_000), 30)

    def test_moq_player_does_not_inherit_hls_floor(self):
        from encode_profile import DEFAULT_MOQ_TARGET_LATENCY_MS, moq_player_target_latency_ms

        self.assertEqual(moq_player_target_latency_ms(2000), DEFAULT_MOQ_TARGET_LATENCY_MS)
        self.assertEqual(moq_player_target_latency_ms(400), 400)
        self.assertEqual(moq_player_target_latency_ms(100), 100)

    def test_summary_splits_hls_and_moq_budgets(self):
        from encode_profile import DEFAULT_MOQ_TARGET_LATENCY_MS, encode_profile_summary

        summary = encode_profile_summary("720p", 2000)
        self.assertEqual(summary["hls_segment_sec"], 2)
        self.assertEqual(summary["gop_frames"], 60)
        self.assertEqual(summary["moq_target_latency_ms"], DEFAULT_MOQ_TARGET_LATENCY_MS)
        self.assertEqual(summary["moq_gop_frames"], 8)

    def test_build_ffmpeg_moq_cmd_uses_moq_gop(self):
        cmd = build_ffmpeg_moq_cmd(
            "clip.mp4",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=4000,
            duration_sec=30,
        )
        g_index = cmd.index("-g")
        self.assertEqual(cmd[g_index + 1], "30")
        keyint_index = cmd.index("-keyint_min")
        self.assertEqual(cmd[keyint_index + 1], "30")

    def test_solo_webcam_moq_uses_half_second_gop(self):
        cmd = build_ffmpeg_moq_cmd(
            "device:webcam",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=400,
            duration_sec=60,
        )
        self.assertEqual(cmd[cmd.index("-g") + 1], "8")
        self.assertEqual(cmd[cmd.index("-keyint_min") + 1], "8")
        self.assertEqual(cmd[cmd.index("-preset") + 1], "ultrafast")

    def test_webcam_udp_moq_cmd_copies_broker_encode(self):
        cmd = build_ffmpeg_moq_cmd(
            "udp://127.0.0.1:50123?fifo_size=1000000",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=400,
            duration_sec=60,
        )
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "copy")
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "aac")
        self.assertNotIn("-bsf:a", cmd)
        self.assertEqual(cmd[cmd.index("-probesize") + 1], "2M")
        self.assertEqual(cmd[cmd.index("-analyzeduration") + 1], "2000000")
        self.assertNotIn("-preset", cmd)
        self.assertNotIn("-g", cmd)
        self.assertNotIn("use_wallclock_as_timestamps", cmd)

    def test_webcam_udp_moq_cmd_reencodes_when_dest_count_ge_2(self):
        self.assertFalse(should_reencode_brokered_moq(1))
        self.assertTrue(should_reencode_brokered_moq(2))
        copy = build_ffmpeg_moq_cmd(
            "udp://127.0.0.1:50123?fifo_size=1000000",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=400,
            duration_sec=60,
            dest_count=1,
        )
        self.assertEqual(copy[copy.index("-c:v") + 1], "copy")
        cmd = build_ffmpeg_moq_cmd(
            "udp://127.0.0.1:50123?fifo_size=1000000",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=400,
            duration_sec=60,
            dest_count=6,
        )
        self.assertEqual(cmd[cmd.index("-c:v") + 1], "libx264")
        self.assertEqual(cmd[cmd.index("-preset") + 1], "ultrafast")
        self.assertEqual(cmd[cmd.index("-g") + 1], "8")
        self.assertEqual(cmd[cmd.index("-b:v") + 1], "1500k")
        self.assertIn("scale=-2:540", " ".join(cmd))
        self.assertNotEqual(cmd[cmd.index("-c:v") + 1], "copy")

    def test_publisher_drop_count_from_sampled_log(self):
        log = (
            "sender ready (namespace + catalog published)\n"
            + "".join(
                "write(vide_1) would block after retry; dropping fragment (3)\n" for _ in range(3)
            )
            + "write(vide_1) would block after retry; dropping fragment (50)\n"
        )
        self.assertEqual(publisher_fragment_drop_count(log), 50)
        self.assertIn("50", publisher_write_block_error(log) or "")
        self.assertIsNone(publisher_write_block_error("sender ready\nobj vide wall_dt_ms=0\n"))

    def test_file_moq_cmd_keeps_veryfast(self):
        cmd = build_ffmpeg_moq_cmd(
            "clip.mp4",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=400,
            duration_sec=30,
        )
        self.assertEqual(cmd[cmd.index("-preset") + 1], "veryfast")

    def test_encode_args_include_utc_burnin(self):
        args = build_video_encode_args("720p", 4000, burnin_epoch_sec=1_700_000_000)
        vf = args[args.index("-vf") + 1]
        self.assertIn("drawtext", vf)
        self.assertIn("encode time %{pts\\:hms}", vf)
        self.assertNotIn("gmtime\\:1700000000", vf)
        live = build_video_encode_args("720p", 4000, wallclock_pts=True)
        live_vf = live[live.index("-vf") + 1]
        self.assertIn("capture time %{pts\\:gmtime}Z", live_vf)
        self.assertNotIn("pts\\:gmtime\\:", live_vf)
        moq = build_ffmpeg_moq_cmd(
            "clip.mp4",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=4000,
        )
        moq_vf = moq[moq.index("-vf") + 1]
        self.assertIn("encode time %{pts\\:hms}", moq_vf)
        live_moq = build_ffmpeg_moq_cmd(
            "udp://127.0.0.1:9",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=4000,
        )
        self.assertEqual(live_moq[live_moq.index("-c:v") + 1], "copy")
        self.assertNotIn("-vf", live_moq)
        cam = build_ffmpeg_moq_cmd(
            "device:webcam",
            progress_path="/tmp/progress.txt",
            encode_ladder="720p",
            target_latency_ms=400,
        )
        joined_cam = " ".join(cam)
        self.assertTrue("avfoundation" in joined_cam or "v4l2" in joined_cam)
        self.assertNotIn("udp://", joined_cam)
        self.assertEqual(cam[cam.index("-c:v") + 1], "libx264")
        self.assertEqual(cam[cam.index("-preset") + 1], "ultrafast")
        self.assertEqual(cam[cam.index("-g") + 1], "8")
        self.assertIn("1280x720", joined_cam)
        self.assertNotIn("-fps_mode", cam)
        self.assertIn("setpts=PTS-STARTPTS", joined_cam)
        self.assertIn("asetpts=PTS-STARTPTS", joined_cam)

    def test_file_and_cloud_group_duration_is_solo_not_broker(self):
        solo = moq_group_duration_ms(400, brokered=False)
        self.assertLess(solo, 1000.0)
        self.assertEqual(moq_group_duration_ms(400, brokered=True), 1000.0)


if __name__ == "__main__":
    unittest.main()
