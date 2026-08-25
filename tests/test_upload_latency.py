"""upload_latency_ms is encode-ready → first ingest publish, not RTT/E2E."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from metrics import UploadLatencyTracker, ffmpeg_bits_ready  # noqa: E402
from moq_publish import (  # noqa: E402
    publisher_catalog_published,
    publisher_first_object_sent,
)


class UploadLatencyTests(unittest.TestCase):
    def test_ffmpeg_bits_ready_needs_media_or_bytes(self) -> None:
        self.assertFalse(ffmpeg_bits_ready("00:00:00.000000", 0))
        self.assertTrue(ffmpeg_bits_ready("00:00:00.040000", 0))
        self.assertTrue(ffmpeg_bits_ready("00:00:00.000000", 1200))

    def test_tracker_stays_none_until_publish_success(self) -> None:
        ticks = {"t": 1.0}

        def clock() -> float:
            return ticks["t"]

        tracker = UploadLatencyTracker()
        tracker.note_encode_ready(True, clock=clock)
        self.assertIsNone(tracker.value_ms)
        ticks["t"] = 1.25
        self.assertEqual(tracker.note_publish_success(True, clock=clock), 250.0)
        ticks["t"] = 2.0
        self.assertEqual(tracker.note_publish_success(True, clock=clock), 250.0)

    def test_first_object_is_publish_success_connection_id_is_not(self) -> None:
        self.assertFalse(publisher_first_object_sent("connection_id=wt-1\n"))
        self.assertTrue(
            publisher_first_object_sent("live: sent track=vide_1 bytes=191598\n")
        )
        self.assertTrue(publisher_first_object_sent("object write MOQ_OK group=0\n"))
        self.assertTrue(publisher_first_object_sent("obj vide wall_dt_ms=999 bytes=322195 sync=1\n"))

    def test_catalog_published_ignores_connect_and_old_empty_catalog(self) -> None:
        self.assertFalse(publisher_catalog_published("connection_id=moq5-wt ns=bench-x\n"))
        self.assertFalse(
            publisher_catalog_published(
                "track added: vide_1\nlive: sent track=vide_1 bytes=177784\n"
            )
        )
        self.assertTrue(
            publisher_catalog_published(
                "sender ready (namespace + catalog published)\n"
            )
        )
        self.assertTrue(
            publisher_catalog_published(
                "attaching sender after CMAF init (2 tracks; first live "
                "catalog will include vide/soun)\n"
                "track added: vide_1 (id=1 codec=avc1.4d4028 init=774 bytes)\n"
                "obj vide wall_dt_ms=1000 bytes=102735 sync=1\n"
            )
        )


if __name__ == "__main__":
    unittest.main()
