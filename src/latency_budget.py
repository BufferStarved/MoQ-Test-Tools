"""Per-component latency decomposition and normalized frame accounting.

A single ``e2e_latency_ms`` number tells an operator that a leg is slow but
never where the time went, and the per-protocol e2e estimators differ enough
(CaptureTimestamp vs PDT vs wall−playhead) that comparing two legs' totals can
be misleading on its own. This module defines one ordered chain of components
that every protocol reports in the same units, so a slow leg can be attributed:

    capture ──encode──> muxed ──cmaf_group──> publish ──network──> ingest
            ──packager──> player_buffer──> glass

Three properties keep the attribution honest, and each exists because the
first version of this model got it wrong in a way that live legs exposed:

**Disagreement is signed.** ``latency_residual_ms`` is measured e2e the
components cannot explain; ``latency_overcount_ms`` is the components
exceeding measured e2e. Exactly one can be non-zero. The residual alone was
clamped at 0, which made a leg that over-attributed by 1721 ms
(Linode WebRTC, 2026-08-22: 1419 ms of components against a 35 ms measured
e2e) look identical to one that reconciled exactly.

**The chain is only summed over what the e2e estimator actually spans.**
WHEP's e2e is a receiver-side path delay (jitter buffer + ICE RTT/2); it
structurally cannot see the sender's encode pipeline, so adding a sender-side
``latency_encode_ms`` to it is a category error, not a rounding difference.
``e2e_scope`` records which span was measured and ``accounted_ms`` sums only
the components inside it.

**A stage with no instrument is named, not zeroed.** ``0.0`` in a component
column means "measured, and it was zero"; a stage listed in
``latency_unmeasured`` means "nothing measures this here" and is the reason
the residual is large. Zixi carries no PDT, so its packager stage has no
instrument — reporting that as a confident 0 while the docs blamed "Zixi chunk
packaging" for the residual was a contradiction the CSV could not show.

Every helper is pure so the frontend mirror (``web/frontend/src/latencyBudget.ts``)
can be diffed against it, and so the formulas are unit-testable without a run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Optional, Tuple

# Ordered pipeline stages. Order is the chain order, which is what the UI
# stacks and what `accounted_ms` sums.
LATENCY_COMPONENTS = (
    "latency_encode_ms",
    "latency_segmentation_ms",
    "latency_publish_ms",
    "latency_network_ms",
    "latency_packager_ms",
    "latency_player_buffer_ms",
)

# Short stage names used by latency_unmeasured / latency_not_applicable.
STAGE_NAMES = (
    "encode",
    "segmentation",
    "publish",
    "network",
    "packager",
    "player_buffer",
)
_STAGE_BY_COLUMN = dict(zip(LATENCY_COMPONENTS, STAGE_NAMES))

LATENCY_COLUMNS = (
    *LATENCY_COMPONENTS,
    "latency_accounted_ms",
    "latency_residual_ms",
    "latency_overcount_ms",
    "latency_unmeasured",
    "latency_not_applicable",
    "latency_e2e_scope",
)

# MediaMTX LL-HLS part duration. This is the HLS *object*, not a 1s CMAF group.
LL_HLS_PART_MS = 200.0
# Zixi Fast HLS segment floor (encode_profile.HLS_SEGMENT_SEC_MIN). Not LL parts.
FAST_HLS_SEGMENT_MS = 2000.0
# Shared webcam broker master IDR cadence (webcam_broker.MASTER_GOP_FRAMES @ 30fps).
BROKER_GOP_MS = 1000.0

FRAME_COLUMNS = (
    "encode_frames_total",
    "encode_frames_dropped",
    "encode_frames_duped",
    "encode_frame_drop_pct",
    "playback_frame_drop_pct",
    "frame_delivery_pct",
)

# What span the leg's `e2e_latency_ms` estimator actually measures. This is not
# cosmetic: it decides which components may be summed against it.
#
# capture_to_glass — wall-clock now minus the encoder-timeline position of the
#   frame on screen (HLS/LL-HLS PDT, HTTP-TS, MoQ CaptureTimestamp/join
#   offset). Includes the sender pipeline, so encode + CMAF group + publish +
#   network + packager + player_buffer are in scope.
# ingest_to_glass — a receiver-side path estimate built from what the viewer
#   can see (WHEP: ICE RTT/2 + jitterBufferDelay). The sender pipeline is
#   invisible to it. `latency_encode_ms` is still reported, because the
#   operator needs to know the sender pipeline exists, but it is excluded from
#   `accounted_ms` — otherwise every WebRTC leg over-attributes by roughly the
#   whole encoder baseline.
# capture_to_ingest — upload-only tests stop at ingest. Encode + CMAF
#   group + publish + network + packager are in scope (segmentation happens
#   before/at ingest on CMAF). player_buffer is out of scope and must not be
#   copied from a confidence monitor into ranking e2e.
E2E_SCOPE_CAPTURE_TO_GLASS = "capture_to_glass"
E2E_SCOPE_INGEST_TO_GLASS = "ingest_to_glass"
E2E_SCOPE_CAPTURE_TO_INGEST = "capture_to_ingest"

# Stages a given scope's e2e estimator does not span.
# ingest_to_glass also excludes CMAF group: WebRTC has no group hop, and a
# WHEP estimate cannot see sender-side object cadence anyway.
_OUT_OF_SCOPE: Dict[str, Tuple[str, ...]] = {
    E2E_SCOPE_INGEST_TO_GLASS: ("latency_encode_ms", "latency_segmentation_ms"),
    E2E_SCOPE_CAPTURE_TO_INGEST: ("latency_player_buffer_ms",),
}

# Sanity ceiling per component. Anything above this is a parse/clock artifact,
# not a real pipeline stage: report 0 rather than poisoning the stack with a
# confident 60s "component". (The old implementation clamped to the ceiling,
# so a 70s artifact became a 60000ms stage that the operator had no way to
# tell apart from a real one — the exact poisoning the ceiling exists to stop.)
_COMPONENT_MAX_MS = 60_000.0

# Measured glass delay gets a much wider window than a single stage: a badly
# broken leg really can sit at 37s (job c49d2ef4, WebRTC, 2026-08-22) and the
# total must survive to be charted. Must match playback_metrics.E2E_MAX_MS and
# glassLatency.E2E_MAX_MS.
_E2E_MAX_MS = 180_000.0


def _clean_ms(value: Optional[float], *, ceiling: float = _COMPONENT_MAX_MS) -> float:
    """Non-negative, finite, plausible milliseconds; 0 for anything else.

    Above ``ceiling`` the number is a parse/clock artifact rather than a
    pipeline stage, so it is dropped to 0. It is deliberately *not* clamped to
    the ceiling: clamping turns a nonsense 70s reading into a confident 60s
    component that stacks, sums and charts exactly like a real measurement.
    """
    try:
        number = float(value if value is not None else 0.0)
    except (TypeError, ValueError):
        return 0.0
    if number != number or number <= 0.0:  # NaN or non-positive
        return 0.0
    if number > ceiling:
        return 0.0
    return number


@dataclass(frozen=True)
class LatencyBudget:
    """One sample's latency decomposition, in milliseconds."""

    encode_ms: float = 0.0
    segmentation_ms: float = 0.0
    publish_ms: float = 0.0
    network_ms: float = 0.0
    packager_ms: float = 0.0
    player_buffer_ms: float = 0.0
    e2e_ms: float = 0.0
    e2e_scope: str = E2E_SCOPE_CAPTURE_TO_GLASS
    #: Component columns whose 0 means "no instrument here", not "no delay".
    #: These are why the residual is large; naming them is the difference
    #: between an unexplained gap and an unmeasured stage.
    unmeasured: FrozenSet[str] = field(default_factory=frozenset)
    #: Stages that structurally do not exist on this protocol (WebRTC has no
    #: CMAF group). Not unmeasured: there is no instrument to go looking for.
    not_applicable: FrozenSet[str] = field(default_factory=frozenset)

    def _component(self, name: str) -> float:
        return {
            "latency_encode_ms": self.encode_ms,
            "latency_segmentation_ms": self.segmentation_ms,
            "latency_publish_ms": self.publish_ms,
            "latency_network_ms": self.network_ms,
            "latency_packager_ms": self.packager_ms,
            "latency_player_buffer_ms": self.player_buffer_ms,
        }[name]

    @property
    def out_of_scope(self) -> Tuple[str, ...]:
        """Components the leg's e2e estimator does not span (never summed)."""
        return _OUT_OF_SCOPE.get(self.e2e_scope, ())

    @property
    def accounted_ms(self) -> float:
        """Sum of the components the measured e2e actually spans."""
        skip = set(self.out_of_scope) | set(self.not_applicable)
        return round(
            sum(self._component(name) for name in LATENCY_COMPONENTS if name not in skip),
            1,
        )

    @property
    def residual_ms(self) -> float:
        """Measured glass delay the in-scope components do not explain.

        Non-negative by definition — it is a *quantity of unattributed time*.
        The opposite condition (components exceeding measured e2e) is a
        different fact with a different cause, and it gets its own column
        rather than being flattened into this one at 0.
        """
        if self.e2e_ms <= 0:
            return 0.0
        return round(max(0.0, self.e2e_ms - self.accounted_ms), 1)

    @property
    def overcount_ms(self) -> float:
        """In-scope components in excess of measured e2e.

        Non-zero means the model double-counts or mixes spans somewhere, which
        is a modelling bug — but one an operator can only fix if the column
        admits it exists. Exactly one of this and ``residual_ms`` can be
        non-zero.
        """
        if self.e2e_ms <= 0:
            return 0.0
        return round(max(0.0, self.accounted_ms - self.e2e_ms), 1)

    @property
    def unmeasured_stages(self) -> Tuple[str, ...]:
        """Short stage names with no instrument, in chain order."""
        return tuple(
            _STAGE_BY_COLUMN[name] for name in LATENCY_COMPONENTS if name in self.unmeasured
        )

    @property
    def not_applicable_stages(self) -> Tuple[str, ...]:
        """Short stage names that do not exist on this protocol, in chain order."""
        return tuple(
            _STAGE_BY_COLUMN[name]
            for name in LATENCY_COMPONENTS
            if name in self.not_applicable
        )

    def as_row(self) -> Dict[str, str]:
        return {
            "latency_encode_ms": f"{self.encode_ms:.1f}",
            "latency_segmentation_ms": f"{self.segmentation_ms:.1f}",
            "latency_publish_ms": f"{self.publish_ms:.1f}",
            "latency_network_ms": f"{self.network_ms:.1f}",
            "latency_packager_ms": f"{self.packager_ms:.1f}",
            "latency_player_buffer_ms": f"{self.player_buffer_ms:.1f}",
            "latency_accounted_ms": f"{self.accounted_ms:.1f}",
            "latency_residual_ms": f"{self.residual_ms:.1f}",
            "latency_overcount_ms": f"{self.overcount_ms:.1f}",
            "latency_unmeasured": ",".join(self.unmeasured_stages),
            "latency_not_applicable": ",".join(self.not_applicable_stages),
            "latency_e2e_scope": self.e2e_scope,
        }


def encode_latency_ms(
    *,
    pipeline_baseline_ms: Optional[float],
    encode_lag_ms: Optional[float],
    segmentation_ms: Optional[float] = None,
    split_gop_from_encode: bool = False,
) -> float:
    """Capture→encoded-AU delay: constant pipeline offset + sustained lag.

    ``EncodeLagTracker`` reports only the *growth* of (wall − out_time). The
    offset it subtracts (x264 lookahead, mux buffering, device warmup) is
    still real glass delay and is added back here once.

    On MoQ fMP4, ``out_time`` often advances only when a fragment closes, so
    the baseline can include GOP-close wait. Pass ``split_gop_from_encode``
    with the known group duration so encode stays capture→AU and
    ``latency_segmentation_ms`` owns AU→closed group. Do not split on HLS
    parts: those close at the packager, not in this baseline.
    """
    total = _clean_ms(pipeline_baseline_ms) + _clean_ms(encode_lag_ms)
    if split_gop_from_encode:
        gop = _clean_ms(segmentation_ms)
        # Only peel GOP-close wait out of encode when the baseline is large
        # enough to actually contain it. File-source -re advances out_time
        # every frame (~40ms offset); subtracting a 1s GOP zeros a real
        # instrument (GCP MoQ f2ce8fe2: encode 0/28). Brokered/fMP4
        # fragment-close baselines are 1s+ and still split.
        if gop > 0 and _clean_ms(pipeline_baseline_ms) >= gop:
            total = max(0.0, total - gop)
    return round(total, 1)


def resolve_segmentation_ms(
    *,
    protocol: Optional[str] = None,
    playback_engine: Optional[str] = None,
    group_duration_ms: Optional[float] = None,
) -> Tuple[Optional[float], bool]:
    """Object/group cadence for the CMAF-group hop.

    Returns ``(ms_or_none, not_applicable)``. ``None`` + not n/a means
    unmeasured — never report that as 0. WebRTC (WHEP) has no CMAF group.
    SRT/RTMP/HTTP-TS are continuous at muxed→publish; their object wait, if
    any, is the packager. MoQ uses the GOP/group in force (1s when dest_count
    < 2 copies the broker master, else ``moq_gop_frames_for_latency``).
    LL-HLS parts are 200 ms
    — not a 1s CMAF group. 0.5s/1s on MoQ CMAF is group duration
    (NextGroupStart), not ingest RTT.
    """
    proto = (protocol or "").strip().lower()
    engine = (playback_engine or "").strip().lower()
    if proto == "webrtc" and engine not in ("hls", "ll-hls", "dash"):
        return None, True
    if proto in {"srt", "rtmp", "http"} and engine not in ("hls", "ll-hls", "dash"):
        return None, True
    if engine == "whep":
        return None, True
    if engine == "ll-hls" or proto == "hls":
        duration = group_duration_ms if group_duration_ms is not None else LL_HLS_PART_MS
        return _clean_ms(duration), False
    if engine == "hls":
        duration = (
            group_duration_ms if group_duration_ms is not None else FAST_HLS_SEGMENT_MS
        )
        return _clean_ms(duration), False
    if proto == "moq" or engine == "moq":
        if group_duration_ms is None:
            return None, False
        return _clean_ms(group_duration_ms), False
    if proto == "dash" or engine == "dash":
        if group_duration_ms is None:
            return None, False
        return _clean_ms(group_duration_ms), False
    if group_duration_ms is not None:
        return _clean_ms(group_duration_ms), False
    return None, False


def network_latency_ms(*, net_rtt_ms: Optional[float]) -> float:
    """One-way path estimate = RTT/2.

    Symmetric-path assumption. It is the only network number available on
    most protocols (SRT libsrt, RTMP TCP probe, WebRTC ICE), so normalizing on
    it keeps the component comparable even though the underlying measurement
    differs per protocol. MoQ fills ``net_rtt_ms`` from picoquic qlog
    (smoothed_rtt) on the moq5 canary; 0 / missing stays *unmeasured* until
    the first qlog sample (and on openmoq, which has no qlog).
    """
    return round(_clean_ms(net_rtt_ms) / 2.0, 1)


def player_buffer_latency_ms(*, playback_buffer_sec: Optional[float]) -> float:
    """Media queued ahead of the playhead, in ms.

    Strictly "seconds queued AHEAD of the playhead". MoQ LOC's canvas has no
    HTML media buffer and instead reports seconds the glass is BEHIND live —
    the opposite direction — which is carried in its own
    ``playback_behind_live_sec`` field and must never reach this function. A
    LOC leg that leaked "behind live" into here charted a 10.9s "buffer" on
    the protocol that should have been lowest-latency (Linode MoQ,
    2026-08-22).
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
    publish_transit_ms: Optional[float] = None,
    net_rtt_ms: Optional[float] = None,
    packager_transit_ms: Optional[float] = None,
    playback_buffer_sec: Optional[float] = None,
    e2e_latency_ms: Optional[float] = None,
    e2e_scope: str = E2E_SCOPE_CAPTURE_TO_GLASS,
    protocol: Optional[str] = None,
    playback_engine: Optional[str] = None,
    segmentation_ms: Optional[float] = None,
    segmentation_not_applicable: bool = False,
    split_gop_from_encode: bool = False,
) -> LatencyBudget:
    """Assemble one sample's budget.

    ``None`` and ``0.0`` mean different things for the transit inputs. ``None``
    is "no instrument on this leg" and lands the stage in ``unmeasured``;
    ``0.0`` is "measured, and it was zero" (Zixi HTTP-TS really does have no
    packaging buffer). Callers must not paper over a missing instrument with a
    default of 0.

    ``publish_transit_ms`` has no producer yet on any protocol. It used to be
    fed ``upload_latency_ms``, which is a *one-shot startup* measurement
    (encoder-ready → first confirmed publish); adding that constant into every
    steady-state sample inflated ``accounted_ms`` for the whole run — the SRT
    local leg on 2026-08-22 over-attributed on 23 of 24 samples almost
    entirely because of a fixed 1998.9 ms "publish" stage. The startup figure
    still ships, in its own ``upload_latency_ms`` column, labelled as startup.
    """
    unmeasured = set()
    not_applicable: set[str] = set()
    resolved_ms, inferred_na = resolve_segmentation_ms(
        protocol=protocol,
        playback_engine=playback_engine,
        group_duration_ms=segmentation_ms,
    )
    if segmentation_not_applicable or inferred_na:
        not_applicable.add("latency_segmentation_ms")
        resolved_ms = None
    elif resolved_ms is None:
        unmeasured.add("latency_segmentation_ms")
    if publish_transit_ms is None:
        unmeasured.add("latency_publish_ms")
    if net_rtt_ms is None:
        unmeasured.add("latency_network_ms")
    if packager_transit_ms is None:
        unmeasured.add("latency_packager_ms")
    if playback_buffer_sec is None:
        unmeasured.add("latency_player_buffer_ms")

    return LatencyBudget(
        encode_ms=encode_latency_ms(
            pipeline_baseline_ms=pipeline_baseline_ms,
            encode_lag_ms=encode_lag_ms,
            segmentation_ms=resolved_ms,
            split_gop_from_encode=split_gop_from_encode and resolved_ms is not None,
        ),
        segmentation_ms=_clean_ms(resolved_ms),
        publish_ms=_clean_ms(publish_transit_ms),
        network_ms=network_latency_ms(net_rtt_ms=net_rtt_ms),
        packager_ms=_clean_ms(packager_transit_ms),
        player_buffer_ms=player_buffer_latency_ms(playback_buffer_sec=playback_buffer_sec),
        e2e_ms=_clean_ms(e2e_latency_ms, ceiling=_E2E_MAX_MS),
        e2e_scope=e2e_scope,
        unmeasured=frozenset(unmeasured),
        not_applicable=frozenset(not_applicable),
    )


# Protocols whose glass-delay estimator is receiver-side only. Keep in sync
# with the players: WhepPlayer builds e2e from pathDelayMs(ICE RTT, jitter
# buffer), which has no view of the sender.
_INGEST_SCOPE_PROTOCOLS = {"webrtc"}


def e2e_scope_for(
    protocol: Optional[str],
    playback_engine: Optional[str] = None,
    test_scope: Optional[str] = None,
) -> str:
    """Which span this leg's ``e2e_latency_ms`` covers.

    Keyed on the *player*, because that is what computes e2e. A WHIP publish
    watched through an LL-HLS remux is measured by the HLS player and really
    is capture-to-glass, even though the leg is tagged ``webrtc`` — the
    playback-engine caveat covers the fact that it is the wrong path, but the
    span is not the reason. Upload-only tests stop at ingest.
    """
    if (test_scope or "").strip().lower() == "upload":
        return E2E_SCOPE_CAPTURE_TO_INGEST
    engine = (playback_engine or "").strip().lower()
    if engine == "monitor":
        return E2E_SCOPE_CAPTURE_TO_INGEST
    if engine:
        return E2E_SCOPE_INGEST_TO_GLASS if engine == "whep" else E2E_SCOPE_CAPTURE_TO_GLASS
    proto = (protocol or "").strip().lower()
    return (
        E2E_SCOPE_INGEST_TO_GLASS
        if proto in _INGEST_SCOPE_PROTOCOLS
        else E2E_SCOPE_CAPTURE_TO_GLASS
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


# A delivery ratio far above 100% is a broken denominator, not a fast player.
_DELIVERY_MAX_PCT = 1000.0


def frame_delivery_pct(
    *,
    encode_frames_total: Optional[float],
    playback_frames_rendered: Optional[float],
    encode_frames_at_attach: Optional[float] = None,
    playback_frames_at_attach: Optional[float] = None,
) -> Optional[float]:
    """End-to-end frame yield over a window both counters actually share.

    The one frame metric that spans the whole chain, and the only one that
    catches loss in the middle (relay drop, packager gap, decoder flush) that
    neither endpoint counter sees.

    Both inputs are cumulative counters, but they do not start or stop
    together: the browser attaches seconds after ffmpeg and detaches before
    it. Dividing the raw totals measured the *attach offset*, not delivery —
    every leg of the 2026-08-22 matrix read 3.6–10.1% with zero drops
    anywhere, and the Linode Zixi RTMP leg decayed 48.0% → 10.1% purely
    because ``playback_frames_rendered`` froze at 84 while
    ``encode_frames_total`` climbed to 835.

    The fix is to difference *both* counters against their value when the
    player attached, so the ratio is over one shared window. With no attach
    point there is no shared window, and the honest answer is ``None``
    (unknown) rather than a number that looks like loss.

    Callers must also pass counters read at the *same instant*. A player
    value forward-filled across a staleness window divided by a live encoder
    total decays on its own — 100.00 → 66.67 → 50.00 → 40.00 on the
    2026-08-23 RTMP leg with the player parked at 73 rendered and nothing
    lost. ``playback_metrics`` upholds this by pinning the encoder total to
    its value at the player's last report.

    Not capped at 100%: a player reading ahead of the encoder counter means
    clock skew or a mis-placed attach point, and silently clamping that to a
    perfect 100% hides it. Only an absurd ratio is rejected outright.
    """
    if encode_frames_at_attach is None:
        return None
    encoded_window = _clean_count(encode_frames_total) - _clean_count(encode_frames_at_attach)
    rendered_window = _clean_count(playback_frames_rendered) - _clean_count(
        playback_frames_at_attach
    )
    if encoded_window <= 0 or rendered_window < 0:
        return None
    pct = round((rendered_window / encoded_window) * 100.0, 2)
    if pct > _DELIVERY_MAX_PCT:
        return None
    return pct


def build_frame_row(
    *,
    encode_frames_total: Optional[float] = None,
    encode_frames_dropped: Optional[float] = None,
    encode_frames_duped: Optional[float] = None,
    playback_frames_rendered: Optional[float] = None,
    playback_frames_dropped: Optional[float] = None,
    encode_frames_at_attach: Optional[float] = None,
    playback_frames_at_attach: Optional[float] = None,
) -> Dict[str, str]:
    delivery = frame_delivery_pct(
        encode_frames_total=encode_frames_total,
        playback_frames_rendered=playback_frames_rendered,
        encode_frames_at_attach=encode_frames_at_attach,
        playback_frames_at_attach=playback_frames_at_attach,
    )
    return {
        "encode_frames_total": str(_clean_count(encode_frames_total)),
        "encode_frames_dropped": str(_clean_count(encode_frames_dropped)),
        "encode_frames_duped": str(_clean_count(encode_frames_duped)),
        "encode_frame_drop_pct": f"{encode_frame_drop_pct(frames_total=encode_frames_total, frames_dropped=encode_frames_dropped):.3f}",
        "playback_frame_drop_pct": f"{playback_frame_drop_pct(frames_rendered=playback_frames_rendered, frames_dropped=playback_frames_dropped):.3f}",
        # Empty, not 0: "no common window yet" is not "nothing was delivered".
        "frame_delivery_pct": "" if delivery is None else f"{delivery:.2f}",
    }


__all__ = [
    "E2E_SCOPE_CAPTURE_TO_GLASS",
    "E2E_SCOPE_INGEST_TO_GLASS",
    "E2E_SCOPE_CAPTURE_TO_INGEST",
    "BROKER_GOP_MS",
    "FAST_HLS_SEGMENT_MS",
    "FRAME_COLUMNS",
    "LATENCY_COLUMNS",
    "LATENCY_COMPONENTS",
    "LL_HLS_PART_MS",
    "STAGE_NAMES",
    "LatencyBudget",
    "build_frame_row",
    "build_latency_budget",
    "e2e_scope_for",
    "encode_frame_drop_pct",
    "encode_latency_ms",
    "frame_delivery_pct",
    "network_latency_ms",
    "playback_frame_drop_pct",
    "player_buffer_latency_ms",
    "resolve_segmentation_ms",
]
