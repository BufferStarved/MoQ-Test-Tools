"""When a MoQ player is allowed to subscribe.

A premature preview_ready makes MoqPlayer inject a catalog and SUBSCRIBE
before the publisher has announced the namespace — the relay returns
0x10 (no such namespace or track) and the player's retry budget is wasted.
"""

from __future__ import annotations


def should_mark_moq_preview_ready(
    *,
    publish_confirmed: bool,
    poller_enabled: bool,
    past_deadline: bool,
) -> bool:
    """True only when this job's namespace is known-live, or we cannot observe.

    If the moqx admin poller is enabled, never time out into "ready" — an empty
    east/Linode relay used to look identical to a slow publish and the player
    joined with a guaranteed 0x10. When metrics are not configured at all,
    keep the old bounded fallback so VOD is not stuck forever.
    """
    if publish_confirmed:
        return True
    if poller_enabled:
        return False
    return past_deadline


def moq_job_should_fail_without_namespace(
    *,
    publish_confirmed: bool,
    poller_observing: bool,
) -> bool:
    """True when encode-only success would lie: relay never saw this namespace.

    When the moqx admin poller is observing, a 60s dummy encode that never
    increments publish_namespace_success is a publisher/relay failure — not a
    player 0x10 miss. The 2026-08-19 east comparison (bench-733f1d7c) completed
    with 240 CMAF fragments and moqx_ns=0; the tile showed catalog-miss.
    """
    return bool(poller_observing) and not bool(publish_confirmed)


def moq_publish_missing_error(*, namespace: str = "", observing: bool = True) -> str:
    ns = (namespace or "").strip() or "this namespace"
    if observing:
        return (
            f"MoQ publisher never announced namespace {ns} on the relay. "
            "Encode produced CMAF but the catalog is not live. "
            "This is not a player 0x10 subscribe miss."
        )
    return (
        f"MoQ publisher never confirmed namespace {ns} on the relay "
        "(admin metrics unreachable). Catalog cannot load."
    )
