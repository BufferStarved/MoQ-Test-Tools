"""Unit tests for MoqxStatsPoller.publish_namespace_success_delta().

moqx's Prometheus counters are relay-lifetime cumulative, not scoped to a
namespace/session — a relay reused across many benchmark runs can already
show dozens of successes before this job's publisher even connects. Callers
(job_manager's MoQ preview-ready gate) need a *this job's window* delta, not
the raw cumulative value.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moqx_stats import MoqxStatsPoller  # noqa: E402


def _metrics_body(publish_namespace_success: int, subscribe_success: int = 0) -> str:
    return (
        f"moqx_pubPublishNamespaceSuccess_total {publish_namespace_success}\n"
        f"moqx_pubSubscribeSuccess_total {subscribe_success}\n"
    )


class MoqxStatsPollerTests(unittest.TestCase):
    def _poller_with_responses(self, bodies: list[str]) -> MoqxStatsPoller:
        poller = MoqxStatsPoller("https://relay.example.com:4433/moq-relay?namespace=benchmark")
        self.assertTrue(poller.enabled)
        responses = iter(bodies)

        def fake_urlopen(*_args, **_kwargs):
            body = next(responses)

            class _Resp:
                def __enter__(self):
                    return self

                def __exit__(self, *exc):
                    return False

                def read(self):
                    return body.encode("utf-8")

            return _Resp()

        self._patcher = patch("moqx_stats.urllib.request.urlopen", side_effect=fake_urlopen)
        self._patcher.start()
        self.addCleanup(self._patcher.stop)
        return poller

    def test_delta_is_zero_before_any_poll(self):
        poller = MoqxStatsPoller("https://relay.example.com:4433/moq-relay?namespace=benchmark")
        self.assertEqual(poller.publish_namespace_success_delta(), 0)

    def test_relay_already_busy_does_not_show_as_this_jobs_success(self):
        """A relay reused across many runs already shows a high cumulative
        count on the very first poll — that must not look like *this* job's
        publish succeeded."""
        poller = self._poller_with_responses([_metrics_body(56), _metrics_body(56)])
        poller.poll()  # baseline poll, matches upload_service's bootstrap call
        self.assertEqual(poller.publish_namespace_success_delta(), 0)
        poller.poll()  # no change yet — publisher still not registered
        self.assertEqual(poller.publish_namespace_success_delta(), 0)

    def test_delta_increments_once_this_jobs_publish_succeeds(self):
        poller = self._poller_with_responses(
            [_metrics_body(56), _metrics_body(56), _metrics_body(57)]
        )
        poller.poll()  # baseline
        self.assertEqual(poller.publish_namespace_success_delta(), 0)
        poller.poll()  # still not registered
        self.assertEqual(poller.publish_namespace_success_delta(), 0)
        poller.poll()  # publisher registered its namespace
        self.assertEqual(poller.publish_namespace_success_delta(), 1)

    def test_disabled_poller_returns_zero(self):
        with patch.dict("os.environ", {}, clear=False):
            poller = MoqxStatsPoller("not-a-url")
        self.assertFalse(poller.enabled)
        self.assertEqual(poller.publish_namespace_success_delta(), 0)


if __name__ == "__main__":
    unittest.main()
