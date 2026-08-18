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
