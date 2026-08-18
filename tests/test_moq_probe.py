""" /api/moq/probe must distinguish lifetime totals from since-last-probe. """

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moqx_stats import (  # noqa: E402
    MoqxStatsSnapshot,
    _LAST_PROBE,
    interpret_moqx_probe,
    parse_moqx_metrics,
    remember_probe,
    snapshot_delta,
)


def _body(*, success=39, error=66, tne=64, ns=12, received=0, done=0) -> str:
    return (
        f"moqx_pubSubscribeSuccess_total {success}\n"
        f"moqx_pubSubscribeError_total {error}\n"
        f'moqx_pubSubscribeError_by_code_total{{code="track_not_exist"}} {tne}\n'
        f"moqx_subPublishNamespaceSuccess_total {ns}\n"
        f"moqx_moqPublishReceived_total {received}\n"
        f"moqx_pubPublishDone_total {done}\n"
    )


class MoqProbeInterpretationTests(unittest.TestCase):
    def setUp(self) -> None:
        _LAST_PROBE.clear()

    def test_parse_includes_track_not_exist(self) -> None:
        snap = parse_moqx_metrics(_body())
        self.assertEqual(snap.subscribe_success, 39)
        self.assertEqual(snap.subscribe_error, 66)
        self.assertEqual(snap.subscribe_error_track_not_exist, 64)
        self.assertEqual(snap.publish_namespace_success, 12)

    def test_lifetime_tne_with_publish_is_historical_not_broken(self) -> None:
        lifetime = parse_moqx_metrics(_body())
        checks = interpret_moqx_probe(
            lifetime, lifetime, had_prior_probe=False
        )
        self.assertIn("historical_track_not_exist", checks)
        self.assertNotIn("relay_playback_broken", checks)
        self.assertIn("relay_metrics_look_healthy", checks)

    def test_window_tne_without_publish_is_broken(self) -> None:
        lifetime = MoqxStatsSnapshot(
            subscribe_success=39,
            subscribe_error=67,
            subscribe_error_track_not_exist=65,
        )
        window = MoqxStatsSnapshot(
            subscribe_error=1,
            subscribe_error_track_not_exist=1,
        )
        checks = interpret_moqx_probe(lifetime, window, had_prior_probe=True)
        self.assertIn("subscribe_track_not_exist", checks)
        self.assertIn("relay_playback_broken", checks)

    def test_since_last_probe_delta_ignores_historical_tne(self) -> None:
        first = parse_moqx_metrics(_body(tne=64, error=66, ns=12))
        second = parse_moqx_metrics(_body(tne=64, error=66, ns=13, success=41))
        remember_probe("http://relay/metrics", first)
        previous = remember_probe("http://relay/metrics", second)
        self.assertIsNotNone(previous)
        window = snapshot_delta(second, previous)
        self.assertEqual(window.subscribe_error_track_not_exist, 0)
        self.assertEqual(window.subscribe_success, 2)
        checks = interpret_moqx_probe(second, window, had_prior_probe=True)
        self.assertIn("historical_track_not_exist", checks)
        self.assertNotIn("relay_playback_broken", checks)


if __name__ == "__main__":
    unittest.main()
