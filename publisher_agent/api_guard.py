"""Gate which orchestrator a laptop helper may attach to.

A helper without a browser session on the public site is how one laptop
camera became every visitor's Webcam+ffmpeg source. Public attach is
allowed only with LOCAL_PUBLISHER_SESSION from that visitor's UI.
"""

from __future__ import annotations

import os
from urllib.parse import urlparse

PUBLIC_ORCHESTRATOR_HOSTS = frozenset(
    {
        "moq.sean-mccarthy.net",
        "sean-mccarthy.net",
        "www.sean-mccarthy.net",
        "34.9.217.178",
    }
)
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _hostname(api: str) -> str:
    raw = (api or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = "http://" + raw
    host = urlparse(raw).hostname or ""
    return host.lower().strip("[]")


def is_public_orchestrator_api(api: str) -> bool:
    host = _hostname(api)
    if not host:
        return False
    if host in PUBLIC_ORCHESTRATOR_HOSTS:
        return True
    return host.endswith(".sean-mccarthy.net")


def is_loopback_api(api: str) -> bool:
    return _hostname(api) in LOOPBACK_HOSTS


def publisher_session_value(session: str = "") -> str:
    return (session or os.environ.get("LOCAL_PUBLISHER_SESSION") or "").strip()


def publisher_api_blocked_reason(api: str, session: str = "") -> str | None:
    """Why this API URL must not receive a laptop publisher, or None if allowed."""
    session = publisher_session_value(session)
    if is_public_orchestrator_api(api):
        if session:
            return None
        return (
            "Refusing to attach this laptop camera to the public site without a "
            "browser session. Copy the helper command from the Webcam panel "
            "(it includes LOCAL_PUBLISHER_SESSION) so jobs use your camera only."
        )
    if is_loopback_api(api):
        return None
    allow_remote = (os.environ.get("LOCAL_PUBLISHER_ALLOW_REMOTE") or "").strip().lower()
    if allow_remote in {"1", "true", "yes", "on"}:
        return None
    return (
        "Laptop publisher only connects to localhost unless you pass a "
        "browser session from the UI, or LOCAL_PUBLISHER_ALLOW_REMOTE=1."
    )


def assert_publisher_api_allowed(api: str, session: str = "") -> None:
    reason = publisher_api_blocked_reason(api, session)
    if reason:
        raise SystemExit(reason)
