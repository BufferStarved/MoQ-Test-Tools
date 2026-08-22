"""Metrics that were quietly misleading in the 2026-08-22 four-protocol runs.

Each case here is a formula or label that produced a *plausible-looking* number
that meant something other than what the column name said.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from playback_metrics import (  # noqa: E402
    E2E_MAX_MS,
    playback_engine_caveat,
    robust_e2e_stats,
)


class PlaybackEngineCaveatTests(unittest.TestCase):
    def test_webrtc_played_over_hls_is_flagged(self):
        """c49d2ef4: protocol=webrtc but the tile played the LL-HLS remux of
        the WHIP ingest, so every playback column was an HLS measurement being
        ranked against native-path legs."""
        caveat = playback_engine_caveat("webrtc", "ll-hls")
        self.assertIn("ll-hls", caveat)
        self.assertIn("WEBRTC", caveat)

    def test_native_paths_are_not_flagged(self):
        self.assertEqual(playback_engine_caveat("webrtc", "whep"), "")
        self.assertEqual(playback_engine_caveat("moq", "moq"), "")
        # Zixi RTMP/SRT have no browser-native path; HTTP-TS and Fast HLS are
        # both legitimate delivery for them, not a remux of another protocol.
        self.assertEqual(playback_engine_caveat("rtmp", "mpegts"), "")
        self.assertEqual(playback_engine_caveat("srt", "hls"), "")

    def test_moq_over_hls_is_flagged(self):
        self.assertNotEqual(playback_engine_caveat("moq", "hls"), "")

    def test_unknown_inputs_do_not_invent_a_warning(self):
        self.assertEqual(playback_engine_caveat("", "hls"), "")
        self.assertEqual(playback_engine_caveat("rtmp", ""), "")

    def test_frontend_mirror_exists(self):
        source = (ROOT / "web" / "frontend" / "src" / "metricModel.ts").read_text()
        self.assertIn("playbackEngineCaveat", source)
        self.assertIn("whep", source)

    def test_caveat_is_shown_above_the_verdict(self):
        """The verdict is exactly where a remuxed leg gets ranked as if it were
        its published protocol, so the warning has to precede it."""
        source = (ROOT / "web" / "frontend" / "src" / "SessionMetrics.tsx").read_text()
        self.assertIn("playbackEngineCaveat", source)
        self.assertLess(
            source.index('className="results-caveat"'),
            source.index('className="results-verdict"'),
        )

    def test_pipeline_diagram_names_the_real_player(self):
        """A WHIP leg played over the LL-HLS remux must not label itself WHEP."""
        source = (ROOT / "web" / "frontend" / "src" / "SessionMetrics.tsx").read_text()
        self.assertIn("result.summary_extra?.playback_engine ||", source)


class E2eCeilingTests(unittest.TestCase):
    def test_ceiling_matches_the_browser_constant(self):
        """A 30s backend ceiling against a 180s frontend one meant the worst
        legs in a run reported no e2e at all."""
        browser = (ROOT / "web" / "frontend" / "src" / "glassLatency.ts").read_text()
        self.assertIn("E2E_MAX_MS = 180_000", browser)
        self.assertEqual(E2E_MAX_MS, 180_000.0)

    def test_max_is_the_observed_worst_case_not_the_trimmed_one(self):
        stats = robust_e2e_stats([2900, 3100, 3300, 31_000])
        self.assertIsNotNone(stats)
        self.assertLess(stats["avg"], 5000)
        self.assertEqual(stats["max"], 31_000)


if __name__ == "__main__":
    unittest.main()
