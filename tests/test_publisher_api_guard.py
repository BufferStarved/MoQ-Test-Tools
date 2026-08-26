"""Laptop publisher must never attach to the public orchestrator."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from publisher_agent.api_guard import (  # noqa: E402
    assert_publisher_api_allowed,
    is_public_orchestrator_api,
    publisher_api_blocked_reason,
)


class PublisherApiGuardTests(unittest.TestCase):
    def test_blocks_public_site(self) -> None:
        for url in (
            "https://moq.sean-mccarthy.net",
            "https://moq.sean-mccarthy.net/",
            "wss://moq.sean-mccarthy.net/api/publisher-agent/ws",
            "http://34.9.217.178:8000",
        ):
            self.assertTrue(is_public_orchestrator_api(url), url)
            self.assertIsNotNone(publisher_api_blocked_reason(url), url)
            with self.assertRaises(SystemExit):
                assert_publisher_api_allowed(url)

    def test_allows_loopback(self) -> None:
        for url in ("http://127.0.0.1:8000", "http://localhost:8000"):
            self.assertIsNone(publisher_api_blocked_reason(url), url)

    def test_blocks_other_remote_without_override(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "LOCAL_PUBLISHER_ALLOW_REMOTE"}
        with patch.dict(os.environ, env, clear=True):
            reason = publisher_api_blocked_reason("https://example.com")
            self.assertIsNotNone(reason)

    def test_public_host_stays_blocked_even_with_remote_override(self) -> None:
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in {"LOCAL_PUBLISHER_ALLOW_REMOTE", "LOCAL_PUBLISHER_SESSION"}
        }
        env["LOCAL_PUBLISHER_ALLOW_REMOTE"] = "1"
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNotNone(
                publisher_api_blocked_reason("https://moq.sean-mccarthy.net")
            )

    def test_public_host_allowed_with_browser_session(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "LOCAL_PUBLISHER_SESSION"}
        with patch.dict(os.environ, env, clear=True):
            self.assertIsNone(
                publisher_api_blocked_reason(
                    "https://moq.sean-mccarthy.net",
                    "visitor-session-token",
                )
            )
            self.assertIsNotNone(
                publisher_api_blocked_reason("https://moq.sean-mccarthy.net")
            )
