"""Source × protocol start/report map — file and cloud playout must not
inherit webcam-only GOP or a leftover :4433 dest.

A headed 4-way has not been run. These tests would have caught “works on
laptop file, broken on cloud playout / webcam / browser.”
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from destinations import PRESET_BY_ID  # noqa: E402
from encode_profile import moq_group_duration_ms  # noqa: E402
from moq_publish import is_brokered_webcam_udp  # noqa: E402
from upload_service import _job_segmentation  # noqa: E402


def _job(protocol: str, media_path: str, target_latency_ms: int = 400):
    return SimpleNamespace(
        destination=SimpleNamespace(protocol=protocol),
        media_path=media_path,
        target_latency_ms=target_latency_ms,
    )


class SourceProtocolMatrixTests(unittest.TestCase):
    def test_file_and_cloud_playout_are_not_brokered(self):
        for media in ("dummy.mp4", "bbb.mp4", "/tmp/clip.mp4", "device:webcam"):
            self.assertFalse(is_brokered_webcam_udp(media), media)
        self.assertTrue(is_brokered_webcam_udp("udp://127.0.0.1:50123?fifo_size=1000000"))
        self.assertFalse(
            is_brokered_webcam_udp(
                "udp://127.0.0.1:41234?fifo_size=1000000&overrun_nonfatal=1&shared_encode=1"
            )
        )

    def test_moq_segmentation_uses_solo_gop_on_file_and_cloud(self):
        solo = moq_group_duration_ms(400, brokered=False)
        self.assertNotEqual(solo, 1000.0)
        for media in ("dummy.mp4", "bbb.mp4", "/var/lib/moq/upload.mp4"):
            ms, na, split = _job_segmentation(_job("moq", media, 400))
            self.assertFalse(na, media)
            self.assertTrue(split, media)
            self.assertEqual(ms, solo, media)

    def test_brokered_webcam_moq_reports_1s_master_not_solo_gop(self):
        ms, na, split = _job_segmentation(
            _job("moq", "udp://127.0.0.1:50123?timeout=15000000", 400)
        )
        self.assertEqual(ms, 1000.0)
        self.assertFalse(na)
        self.assertTrue(split)

    def test_brokered_webcam_moq_fanout_reports_solo_gop(self):
        job = _job("moq", "udp://127.0.0.1:50123?timeout=15000000", 400)
        job.dest_count = 6
        ms, na, split = _job_segmentation(job)
        self.assertEqual(ms, moq_group_duration_ms(400, brokered=False))
        self.assertFalse(na)
        self.assertTrue(split)

    def test_continuous_publish_has_no_segmentation_hop(self):
        for proto, media in (
            ("srt", "dummy.mp4"),
            ("rtmp", "bbb.mp4"),
            ("webrtc", "dummy.mp4"),
            ("srt", "udp://127.0.0.1:9"),
        ):
            ms, na, split = _job_segmentation(_job(proto, media))
            self.assertIsNone(ms, proto)
            self.assertTrue(na, proto)
            self.assertFalse(split, proto)

    def test_hls_remux_collects_known_object_cadence(self):
        mtx = SimpleNamespace(
            destination=SimpleNamespace(protocol="srt", ingest_provider="gcp_mediamtx"),
            media_path="dummy.mp4",
            target_latency_ms=2000,
        )
        ms, na, split = _job_segmentation(mtx)
        self.assertEqual(ms, 200.0)
        self.assertFalse(na)
        self.assertFalse(split)
        zixi = SimpleNamespace(
            destination=SimpleNamespace(protocol="rtmp", ingest_provider="gcp_zixi"),
            media_path="dummy.mp4",
            target_latency_ms=2000,
        )
        ms, na, split = _job_segmentation(zixi)
        self.assertEqual(ms, 2000.0)
        self.assertFalse(na)
        self.assertFalse(split)

    def test_public_moq_presets_stay_on_14433(self):
        for preset_id in (
            "moq_gcp_relay_d18",
            "moq_gcp_east_relay_d18",
            "moq_linode_relay_d18",
        ):
            preset = PRESET_BY_ID.get(preset_id)
            if preset is None or not (preset.url or "").strip():
                continue
            self.assertIn(":14433", preset.url, preset_id)
            self.assertNotIn(":4433", preset.url, preset_id)


if __name__ == "__main__":
    unittest.main()
