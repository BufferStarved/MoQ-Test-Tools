"""LL-HLS packager transit is PDT − (anchor + media_pos), not (elapsed − 1s)."""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from upload_service import llhls_packager_transit_ms  # noqa: E402


class LlhlsPackagerTransitTests(unittest.TestCase):
    def test_formula_is_pdt_minus_anchor_and_media(self):
        anchor = 1_000.0
        media_pos = 8.0
        pdt = anchor + media_pos + 0.52
        self.assertAlmostEqual(llhls_packager_transit_ms(pdt, anchor, media_pos), 520.0)

    def test_rejects_startup_wait_that_looks_like_elapsed_minus_one(self):
        # Comparison 2026-08-23: first PDT at T+5.6s, media_pos≈1s → 4.6s stuck.
        anchor = 1_000.0
        elapsed = 5.6
        media_pos = 1.0
        pdt = anchor + elapsed
        self.assertIsNone(llhls_packager_transit_ms(pdt, anchor, media_pos))

    def test_accepts_a_later_playlist_with_real_media_position(self):
        anchor = 1_000.0
        media_pos = 20.0
        pdt = anchor + media_pos + 0.48
        self.assertAlmostEqual(llhls_packager_transit_ms(pdt, anchor, media_pos), 480.0)


if __name__ == "__main__":
    unittest.main()
