"""Download Big Buck Bunny for cloud playout (Creative Commons, Blender Foundation)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vod_assets import (  # noqa: E402
    DEFAULT_BUNDLED_CLIP_SEC,
    bbb_media_path,
    clip_vod_duration_sec,
    media_source_catalog,
    resolve_bundled_vod,
)


class VodAssetsTests(unittest.TestCase):
    def test_dummy_resolves(self) -> None:
        path = resolve_bundled_vod(ROOT, "dummy.mp4")
        self.assertIsNotNone(path)
        self.assertTrue(path.is_file())

    def test_bbb_missing_is_none_without_file(self) -> None:
        if bbb_media_path(ROOT) is not None:
            self.skipTest("bbb.mp4 is already present")
        self.assertIsNone(resolve_bundled_vod(ROOT, "bbb.mp4"))

    def test_catalog_lists_bbb(self) -> None:
        catalog = media_source_catalog(ROOT)
        ids = [item["id"] for item in catalog]
        self.assertEqual(ids, ["dummy", "bbb"])
        dummy = catalog[0]
        self.assertTrue(dummy["available"])
        bbb = catalog[1]
        if bbb["available"]:
            self.assertIn("60", bbb["hint"])
        else:
            self.assertIn("fetch-bbb.sh", bbb["hint"])


class VodDurationClipTests(unittest.TestCase):
    def test_bbb_defaults_to_sixty_not_full_file(self) -> None:
        self.assertEqual(
            clip_vod_duration_sec(probed_sec=634, requested=None, bundled=True),
            DEFAULT_BUNDLED_CLIP_SEC,
        )

    def test_dummy_stays_file_length_when_shorter_than_cap(self) -> None:
        self.assertEqual(
            clip_vod_duration_sec(probed_sec=60, requested=None, bundled=True),
            60,
        )

    def test_upload_caps_at_five_minutes(self) -> None:
        self.assertEqual(
            clip_vod_duration_sec(probed_sec=900, requested=None, bundled=False),
            300,
        )

    def test_explicit_request_cannot_exceed_file_or_max(self) -> None:
        self.assertEqual(
            clip_vod_duration_sec(probed_sec=60, requested=180, bundled=True),
            60,
        )
        self.assertEqual(
            clip_vod_duration_sec(probed_sec=400, requested=200, bundled=False),
            200,
        )


if __name__ == "__main__":
    unittest.main()
