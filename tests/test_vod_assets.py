"""Download Big Buck Bunny for cloud playout (Creative Commons, Blender Foundation)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vod_assets import (  # noqa: E402
    bbb_media_path,
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


if __name__ == "__main__":
    unittest.main()
