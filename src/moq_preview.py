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
    """True only when this job's namespace is known-live on the relay.

    Grace-deadline "ready" made an empty east relay look live
    (bench-9f5befdb / bench-2c3781c5: moqx_ns=0, player 0x10, UI said
    one-shot catalog miss). The player already subscribes on job=running.
    ``past_deadline`` is unused; keep the argument so call sites stay.
    """
    del poller_enabled, past_deadline
    return bool(publish_confirmed)


def moq_job_should_fail_without_namespace(
    *,
    publish_confirmed: bool,
    poller_observing: bool,
    catalog_published: bool = False,
) -> bool:
    """True when encode-only success would lie: relay never saw this namespace.

    When the moqx admin poller is observing, a 60s dummy encode that never
    increments publish_namespace_success is a publisher/relay failure — not a
    player 0x10 miss. The 2026-08-19 east comparison (bench-733f1d7c) completed
    with 240 CMAF fragments and moqx_ns=0; the tile showed catalog-miss.

    When the poller cannot scrape (Linode :18000), local ``sender ready`` is
    the only catalog proof. Encode-only without that proof is the same lie
    (bench-aef84d9a: job=completed, SUBSCRIBE 0x10, 0 paint).
    """
    if publish_confirmed or catalog_published:
        return False
    if poller_observing:
        return True
    return True


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
