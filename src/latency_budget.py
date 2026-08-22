"""Per-component latency decomposition and normalized frame accounting.

A single ``e2e_latency_ms`` number tells an operator that a leg is slow but
never where the time went, and the per-protocol e2e estimators differ enough
(CaptureTimestamp vs PDT vs wall−playhead) that comparing two legs' totals can
be misleading on its own. This module defines one ordered chain of components
that every protocol reports in the same units, so a slow leg can be attributed:

    capture ──encode──> muxed ──publish──> ingest ──packager──> delivery
            ──network──> player ──buffer──> glass

``latency_residual_ms`` is deliberately part of the model: it is measured e2e
minus the components we can account for. A large residual is the honest signal
that the estimate and the parts disagree — far better than silently folding the
gap into whichever component happens to be charted.

Every helper is pure so the frontend mirror (``web/frontend/src/latencyBudget.ts``)
can be diffed against it, and so the formulas are unit-testable without a run.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

# Ordered pipeline stages. Order is the chain order, which is what the UI
# stacks and what `accounted_ms` sums.
LATENCY_COMPONENTS = (
    "latency_encode_ms",
    "latency_publish_ms",
    "latency_network_ms",
    "latency_packager_ms",
    "latency_player_buffer_ms",
)

LATENCY_COLUMNS = (*LATENCY_COMPONENTS, "latency_accounted_ms", "latency_residual_ms")

FRAME_COLUMNS = (
    "encode_frames_total",
    "encode_frames_dropped",
    "encode_frames_duped",
    "encode_frame_drop_pct",
    "playback_frame_drop_pct",
    "frame_delivery_pct",
)

# Sanity ceiling per component. Anything above this is a parse/clock artifact,
# not a real pipeline stage; report 0 rather than poisoning the stack.
_COMPONENT_MAX_MS = 60_000.0


def _clean_ms(value: Optional[float]) -> float:
    """Non-negative, finite, plausible milliseconds; 0 for anything else."""
    try:
        number = float(value if value is not None else 0.0)
    except (TypeError, ValueError):
        return 0.0
    if number != number or number <= 0.0:  # NaN or non-positive
        return 0.0
    return min(number, _COMPONENT_MAX_MS)


@dataclass(frozen=True)
class LatencyBudget:
    """One sample's latency decomposition, in milliseconds."""

    encode_ms: float = 0.0
    publish_ms: float = 0.0
    network_ms: float = 0.0
    packager_ms: float = 0.0
    player_buffer_ms: float = 0.0
    e2e_ms: float = 0.0

    @property
    def accounted_ms(self) -> float:
        return round(
            self.encode_ms
            + self.publish_ms
            + self.network_ms
            + self.packager_ms
            + self.player_buffer_ms,
            1,
        )

    @property
    def residual_ms(self) -> float:
        """Measured glass delay the components do not explain (never negative).

        0 means either a clean attribution or no e2e measurement yet. It is
        clamped at 0 because a negative residual means the components
        over-count (double-counted buffer, stale RTT), which is a modelling
        bug to fix at the source rather than a latency to display.
        """
        if self.e2e_ms <= 0:
            return 0.0
        return round(max(0.0, self.e2e_ms - self.accounted_ms), 1)

    def as_row(self) -> Dict[str, str]:
        return {
            "latency_encode_ms": f"{self.encode_ms:.1f}",
            "latency_publish_ms": f"{self.publish_ms:.1f}",
            "latency_network_ms": f"{self.network_ms:.1f}",
            "latency_packager_ms": f"{self.packager_ms:.1f}",
            "latency_player_buffer_ms": f"{self.player_buffer_ms:.1f}",
            "latency_accounted_ms": f"{self.accounted_ms:.1f}",
            "latency_residual_ms": f"{self.residual_ms:.1f}",
        }


def encode_latency_ms(
    *,
    pipeline_baseline_ms: Optional[float],
    encode_lag_ms: Optional[float],
) -> float:
    """Capture→muxed-output delay: constant pipeline offset + sustained lag.

    ``EncodeLagTracker`` deliberately reports only the *growth* of
    (wall − out_time) so the chart answers "is the encoder falling further
    behind". But the offset it subtracts (x264 lookahead, mux buffering,
    device/broker warmup — ~1.2–2.4s measured) is real glass delay and has to
    reappear somewhere in the budget. Here it does, once.
    """
    return round(_clean_ms(pipeline_baseline_ms) + _clean_ms(encode_lag_ms), 1)


def network_latency_ms(*, net_rtt_ms: Optional[float]) -> float:
    """One-way path estimate = RTT/2.

    Symmetric-path assumption. It is the only network number available on
    every protocol (SRT libsrt, RTMP TCP probe, WebRTC ICE, MoQ qlog/probe),
    so normalizing on it keeps the component comparable even though the
    underlying measurement differs per protocol.
    """
    return round(_clean_ms(net_rtt_ms) / 2.0, 1)


def player_buffer_latency_ms(*, playback_buffer_sec: Optional[float]) -> float:
    """Media queued ahead of the playhead, in ms.

    Only meaningful for HTML-media players. MoQ LOC reports "seconds the
    canvas is behind live" in the same column, which is a different quantity;
    callers pass 0 for LOC rather than mixing the two into one component.
    """
    try:
        seconds = float(playback_buffer_sec or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return round(_clean_ms(seconds * 1000.0), 1)


def build_latency_budget(
    *,
    pipeline_baseline_ms: Optional[float] = None,
    encode_lag_ms: Optional[float] = None,
    upload_latency_ms: Optional[float] = None,
    net_rtt_ms: Optional[float] = None,
    packager_transit_ms: Optional[float] = None,
    playback_buffer_sec: Optional[float] = None,
    e2e_latency_ms: Optional[float] = None,
) -> LatencyBudget:
    return LatencyBudget(
        encode_ms=encode_latency_ms(
            pipeline_baseline_ms=pipeline_baseline_ms,
            encode_lag_ms=encode_lag_ms,
        ),
        publish_ms=_clean_ms(upload_latency_ms),
        network_ms=network_latency_ms(net_rtt_ms=net_rtt_ms),
        packager_ms=_clean_ms(packager_transit_ms),
        player_buffer_ms=player_buffer_latency_ms(playback_buffer_sec=playback_buffer_sec),
        e2e_ms=_clean_ms(e2e_latency_ms),
    )


def _clean_count(value: Optional[float]) -> int:
    try:
        number = int(float(value or 0))
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def encode_frame_drop_pct(
    *,
    frames_total: Optional[float],
    frames_dropped: Optional[float],
) -> float:
    """Encoder-side drop rate against frames the encoder actually handled.

    Denominator is total + dropped (frames offered to the encoder), not
    ``fps × elapsed``: a legitimately 24fps source is not dropping 20% of a
    30fps expectation. ffmpeg's own ``drop_frames`` counter is exact, so this
    needs no inference.
    """
    total = _clean_count(frames_total)
    dropped = _clean_count(frames_dropped)
    offered = total + dropped
    if offered <= 0:
        return 0.0
    return round(min(100.0, (dropped / offered) * 100.0), 3)


def playback_frame_drop_pct(
    *,
    frames_rendered: Optional[float],
    frames_dropped: Optional[float],
) -> float:
    """Glass-side drop rate against frames that reached the player.

    Same denominator convention as the encoder side (rendered + dropped =
    delivered), which is what makes the two percentages directly comparable
    instead of one being "of expected" and the other "of delivered".
    """
    rendered = _clean_count(frames_rendered)
    dropped = _clean_count(frames_dropped)
    delivered = rendered + dropped
    if delivered <= 0:
        return 0.0
    return round(min(100.0, (dropped / delivered) * 100.0), 3)


def frame_delivery_pct(
    *,
    encode_frames_total: Optional[float],
    playback_frames_rendered: Optional[float],
) -> float:
    """End-to-end frame yield: painted frames as a share of encoded frames.

    The one frame metric that spans the whole chain, and the only one that
    catches loss in the middle (relay drop, packager gap, decoder flush) that
    neither endpoint counter sees. Capped at 100% because a player that has
    been running longer than the encoder's current sample can legitimately
    read slightly ahead within one sample interval.
    """
    encoded = _clean_count(encode_frames_total)
    rendered = _clean_count(playback_frames_rendered)
    if encoded <= 0 or rendered <= 0:
        return 0.0
    return round(min(100.0, (rendered / encoded) * 100.0), 2)


def build_frame_row(
    *,
    encode_frames_total: Optional[float] = None,
    encode_frames_dropped: Optional[float] = None,
    encode_frames_duped: Optional[float] = None,
    playback_frames_rendered: Optional[float] = None,
    playback_frames_dropped: Optional[float] = None,
) -> Dict[str, str]:
    return {
        "encode_frames_total": str(_clean_count(encode_frames_total)),
        "encode_frames_dropped": str(_clean_count(encode_frames_dropped)),
        "encode_frames_duped": str(_clean_count(encode_frames_duped)),
        "encode_frame_drop_pct": f"{encode_frame_drop_pct(frames_total=encode_frames_total, frames_dropped=encode_frames_dropped):.3f}",
        "playback_frame_drop_pct": f"{playback_frame_drop_pct(frames_rendered=playback_frames_rendered, frames_dropped=playback_frames_dropped):.3f}",
        "frame_delivery_pct": f"{frame_delivery_pct(encode_frames_total=encode_frames_total, playback_frames_rendered=playback_frames_rendered):.2f}",
    }


__all__ = [
    "FRAME_COLUMNS",
    "LATENCY_COLUMNS",
    "LATENCY_COMPONENTS",
    "LatencyBudget",
    "build_frame_row",
    "build_latency_budget",
    "encode_frame_drop_pct",
    "encode_latency_ms",
    "frame_delivery_pct",
    "network_latency_ms",
    "playback_frame_drop_pct",
    "player_buffer_latency_ms",
]
