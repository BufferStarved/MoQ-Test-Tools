from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from moq_preview import should_mark_moq_preview_ready  # noqa: E402


class MoqPreviewReadyGateTests(unittest.TestCase):
    def test_confirmed_publish_is_always_ready(self):
        self.assertTrue(
            should_mark_moq_preview_ready(
                publish_confirmed=True, poller_enabled=True, past_deadline=False
            )
        )

    def test_enabled_poller_never_times_out_on_empty_relay(self):
        self.assertFalse(
            should_mark_moq_preview_ready(
                publish_confirmed=False, poller_enabled=True, past_deadline=True
            )
        )

    def test_no_poller_does_not_grace_into_ready(self):
        self.assertFalse(
            should_mark_moq_preview_ready(
                publish_confirmed=False, poller_enabled=False, past_deadline=False
            )
        )
        self.assertFalse(
            should_mark_moq_preview_ready(
                publish_confirmed=False, poller_enabled=False, past_deadline=True
            )
        )


if __name__ == "__main__":
    unittest.main()
