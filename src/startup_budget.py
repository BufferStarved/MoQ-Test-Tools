"""Phase decomposition of startup, normalized across protocols and providers.

``playback_ttff_ms`` says a leg took 23 seconds to join. It never says *which*
component spent them. That gap is not academic: the RTMP startup win already
banked (23s → 1501 ms) came from reasoning about phases — the GOP was pinned to
the HLS chunk duration, so the first decodable frame could not arrive until a
whole chunk had been packaged. Nothing in the tool measured that. This module
makes the same reasoning a measurement.

Startup is modelled as two ordered chains, deliberately kept apart:

    publisher   job start ──dns──> ──connect──> ──handshake──>
                ──publish_accept──> ──first_idr──> ──first_byte_ingest──> ingest

    player      player attach ──player_request──> ──manifest──>
                ──first_media──> ──first_paint──> glass

**They are two spans, not one.** Between "ingest has the first byte" and "a
player attached" sits however long the operator took to open the tile — dwell
time that belongs to nobody's pipeline. Summing across the join would produce a
"total startup" dominated by human reaction time. Each half therefore
reconciles against its own measured total: the publisher chain against
job-start → first-byte-at-ingest, the player chain against ``playback_ttff_ms``.

Three honesty properties, inherited from ``latency_budget`` because live legs
punished their absence there:

**Disagreement is signed.** ``*_residual_ms`` is measured startup the phases
cannot explain; ``*_overcount_ms`` is phases exceeding the measured total.
Exactly one can be non-zero per half. Clamping the residual at 0 would make an
over-attributing model indistinguishable from one that reconciles.

**A phase with no instrument is named, not zeroed.** ``0.0`` means "measured,
and it was zero". A phase in ``startup_unmeasured`` means "nothing measures
this here" and is *why* the residual is large.

**A phase that does not exist is a third state.** SRT has no TCP connect —
its caller handshake is the connect. Reporting ``startup_connect_ms`` as
"unmeasured" on SRT would send an operator hunting for an instrument that
cannot exist, so structurally-absent phases land in ``startup_not_applicable``
instead. Their time is not lost: the chain anchors the next phase to the last
milestone that *did* happen, so an n/a phase's duration is attributed to the
phase that genuinely contains it.

Durations are derived from milestones, and a phase is measured only when *both*
its bounding milestones are. A missing middle milestone does not get papered
over by stretching its neighbour across the gap — that would silently move time
into whichever phase happened to have an instrument.

Every helper is pure so the frontend mirror (``web/frontend/src/startupBudget.ts``)
can be diffed against it and the formulas unit-tested without a run.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Mapping, Optional, Tuple

# ---------------------------------------------------------------------------
# Phase vocabulary
# ---------------------------------------------------------------------------

# Publisher chain: job start → first media confirmed at the ingest. Order is
# chain order, which is what `accounted_ms` sums and what the UI stacks.
STARTUP_PUBLISHER_COMPONENTS = (
    "startup_dns_ms",
    "startup_connect_ms",
    "startup_handshake_ms",
    "startup_publish_accept_ms",
    "startup_first_idr_ms",
    "startup_first_byte_ingest_ms",
)

# Player chain: player attach → first painted frame.
STARTUP_PLAYER_COMPONENTS = (
    "startup_player_request_ms",
    "startup_manifest_ms",
    "startup_first_media_ms",
    "startup_first_paint_ms",
)

STARTUP_COMPONENTS = (*STARTUP_PUBLISHER_COMPONENTS, *STARTUP_PLAYER_COMPONENTS)

# Short stage names used by the `startup_unmeasured` / `startup_not_applicable`
# columns, in chain order.
PUBLISHER_STAGE_NAMES = (
    "dns",
    "connect",
    "handshake",
    "publish_accept",
    "first_idr",
    "first_byte_ingest",
)
PLAYER_STAGE_NAMES = (
    "player_request",
    "manifest",
    "first_media",
    "first_paint",
)
STAGE_NAMES = (*PUBLISHER_STAGE_NAMES, *PLAYER_STAGE_NAMES)

_STAGE_BY_COLUMN: Dict[str, str] = dict(zip(STARTUP_COMPONENTS, STAGE_NAMES))
_COLUMN_BY_STAGE: Dict[str, str] = {stage: col for col, stage in _STAGE_BY_COLUMN.items()}

STARTUP_COLUMNS = (
    *STARTUP_COMPONENTS,
    "startup_publisher_accounted_ms",
    "startup_publisher_measured_ms",
    "startup_publisher_residual_ms",
    "startup_publisher_overcount_ms",
    "startup_player_accounted_ms",
    "startup_player_measured_ms",
    "startup_player_residual_ms",
    "startup_player_overcount_ms",
    "startup_unmeasured",
    "startup_not_applicable",
)

# ---------------------------------------------------------------------------
# Per-protocol normalization
# ---------------------------------------------------------------------------

# What each phase means on each protocol, and which phases do not exist there.
#
# This table is the normalization work. Two protocols reporting
# `startup_handshake_ms` must be reporting comparable things, or the column is
# worse than useless — it invites a comparison that is a category error. Where
# a protocol folds two phases into one transaction, the absent phase is marked
# not-applicable rather than measured at 0.
_NOT_APPLICABLE: Dict[str, Tuple[str, ...]] = {
    # SRT's caller handshake *is* its connect: there is no separate transport
    # connect over UDP to time. Attributing the whole exchange (including key
    # material) to `handshake` keeps it comparable with RTMP's handshake,
    # which is likewise "after the socket, before publish is accepted".
    "srt": ("startup_connect_ms",),
    # QUIC folds transport connect and crypto into one handshake, and the
    # WebTransport CONNECT that follows is the session phase. Mapping QUIC
    # onto `connect` and WebTransport onto `handshake` keeps six phases
    # meaningful without inventing a TCP connect that never happens.
    "moq": (),
    "rtmp": (),
    # WHIP has no separate "publish accepted" round trip distinct from the
    # POST that returns 201 Created with the answer SDP; that response *is*
    # the accept. It is reported on `publish_accept` and the HTTP request
    # itself on `connect`.
    "webrtc": (),
}

# Human-readable instrument per protocol/phase, for the docs and the UI. An
# empty string means "no instrument on this protocol" — the phase reports
# unmeasured, and this table is where an operator finds out why.
PROTOCOL_PHASE_NOTES: Dict[str, Dict[str, str]] = {
    "rtmp": {
        "dns": "getaddrinfo() on the ingest host, timed in the preflight probe",
        "connect": "TCP connect to the RTMP port (1935), timed in the preflight probe",
        "handshake": "RTMP C0/C1/S0/S1/S2 exchange plus connect/createStream/publish",
        "publish_accept": "ingest reports the input live (Zixi input ready / MediaMTX path ready)",
        "first_idr": "encoder emits its first frame, which for H.264 is an IDR",
        "first_byte_ingest": "ingest reports bytes received on the path",
    },
    "srt": {
        "dns": "getaddrinfo() on the ingest host, timed in the preflight probe",
        "connect": "",  # not applicable — see _NOT_APPLICABLE
        "handshake": "SRT caller handshake including key material exchange",
        "publish_accept": "ingest reports the input live (Zixi input ready / MediaMTX path ready)",
        "first_idr": "encoder emits its first frame, which for H.264 is an IDR",
        "first_byte_ingest": "libsrt reports a non-zero send rate / ingest reports bytes received",
    },
    "webrtc": {
        "dns": "getaddrinfo() on the WHIP host, timed in the preflight probe",
        "connect": "TCP/TLS connect to the WHIP endpoint (8889), timed in the preflight probe",
        "handshake": "ICE establishment and DTLS setup",
        "publish_accept": "WHIP POST offer → 201 Created with the answer SDP",
        "first_idr": "encoder emits its first frame, which for H.264 is an IDR",
        "first_byte_ingest": "MediaMTX reports bytes received (first RTP landed)",
    },
    "moq": {
        "dns": "getaddrinfo() on the relay host, timed in the preflight probe",
        "connect": "QUIC handshake (transport + crypto in one exchange)",
        "handshake": "WebTransport session established over the QUIC connection",
        "publish_accept": "SETUP/ANNOUNCE accepted and the catalog published "
        "('sender ready (namespace + catalog published)')",
        "first_idr": "encoder emits its first frame, which for H.264 is an IDR",
        "first_byte_ingest": "first object on the wire ('obj vide wall_dt_ms=')",
    },
}

PLAYER_PHASE_NOTES: Dict[str, Dict[str, str]] = {
    # Keyed by playback engine, because the player is what measures these.
    "hls": {
        "player_request": "Resource Timing on the manifest request: fetchStart → requestStart "
        "(DNS + connect + TLS)",
        "manifest": "Resource Timing on the manifest: requestStart → responseEnd",
        "first_media": "first media segment response completes",
        "first_paint": "first frame painted (currentTime advances past the session origin)",
    },
    "ll-hls": {
        "player_request": "Resource Timing on the manifest request: fetchStart → requestStart",
        "manifest": "Resource Timing on the manifest: requestStart → responseEnd",
        "first_media": "first partial segment response completes",
        "first_paint": "first frame painted (currentTime advances past the session origin)",
    },
    "mpegts": {
        "player_request": "Resource Timing on the TS request: fetchStart → requestStart",
        # An MPEG-TS pull has no manifest at all: the first response *is* the
        # media. Reporting a 0 ms manifest would imply an instant fetch.
        "manifest": "",
        "first_media": "first bytes of the TS response (responseStart)",
        "first_paint": "first frame painted (currentTime advances past the session origin)",
    },
    "whep": {
        "player_request": "Resource Timing on the WHEP POST: fetchStart → requestStart",
        "manifest": "WHEP SDP exchange: POST offer → 201 answer (responseEnd)",
        "first_media": "getStats(): ICE candidate-pair succeeded and DTLS connected, "
        "then first inbound-rtp bytes",
        "first_paint": "first frame painted",
    },
    "moq": {
        "player_request": "playa: load() → WebTransport session connected",
        "manifest": "playa: SETUP complete → catalog received (SUBSCRIBE, plus joining FETCH)",
        "first_media": "playa: first group/object received, then decoder configured",
        "first_paint": "playa: first frame rendered to the canvas",
    },
    "dash": {
        "player_request": "Resource Timing on the MPD request: fetchStart → requestStart",
        "manifest": "Resource Timing on the MPD: requestStart → responseEnd",
        "first_media": "first media segment response completes",
        "first_paint": "first frame painted (currentTime advances past the session origin)",
    },
}


def not_applicable_columns(protocol: Optional[str]) -> FrozenSet[str]:
    """Phases that structurally do not exist on this protocol."""
    return frozenset(_NOT_APPLICABLE.get((protocol or "").strip().lower(), ()))


def phase_note(protocol: Optional[str], stage: str) -> str:
    """What instrument backs a phase on a protocol; '' when there is none."""
    table = PROTOCOL_PHASE_NOTES.get((protocol or "").strip().lower(), {})
    return table.get(stage, "")


def player_phase_note(engine: Optional[str], stage: str) -> str:
    table = PLAYER_PHASE_NOTES.get((engine or "").strip().lower(), {})
    return table.get(stage, "")


# ---------------------------------------------------------------------------
# Cleaning
# ---------------------------------------------------------------------------

# Sanity ceiling per phase. Startup phases are allowed to be far larger than a
# steady-state latency component — the 23s RTMP baseline this whole family
# exists to explain was a single phase — so the ceiling is generous. Above it
# the number is a clock artifact, and it is dropped to unmeasured rather than
# clamped: a clamped artifact charts exactly like a real 120s phase.
_PHASE_MAX_MS = 120_000.0

# A measured startup total may legitimately reach the same ceiling.
_TOTAL_MAX_MS = 180_000.0


def _clean_phase_ms(value: Optional[float], *, ceiling: float = _PHASE_MAX_MS) -> Optional[float]:
    """Plausible non-negative milliseconds, or ``None`` for anything else.

    Returns ``None`` — not 0 — for absent or implausible input, so a caller
    cannot accidentally turn "no reading" into "measured zero" by passing
    through a default. Zero itself survives: a phase really can complete
    inside the measurement resolution.
    """
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    if number < 0.0 or number > ceiling:
        return None
    # 0.1 ms is the precision the CSV carries and far below the resolution of
    # any instrument feeding this. Rounding here rather than at format time
    # keeps a phase sum equal to the total the same milestones produce,
    # instead of leaking float dust into the residual.
    return round(number, 1)


def _phase_between(
    start: Optional[float],
    end: Optional[float],
) -> Optional[float]:
    """Duration between two milestones, or ``None`` if either is missing.

    Deliberately strict. If the middle milestone of a chain is missing, the
    honest answer is that *that* phase is unmeasured — not that its neighbour
    was unusually long. Stretching a neighbour across the gap moves real time
    into whichever phase happened to have an instrument, which is precisely
    the misattribution the family exists to prevent.
    """
    if start is None or end is None:
        return None
    return _clean_phase_ms((end - start) * 1000.0)


# ---------------------------------------------------------------------------
# Budget
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StartupHalf:
    """One chain (publisher or player) of the startup decomposition.

    ``phases`` maps column name → milliseconds, with ``None`` meaning "no
    instrument". ``not_applicable`` holds the columns that do not exist on
    this protocol at all.
    """

    columns: Tuple[str, ...]
    phases: Mapping[str, Optional[float]]
    measured_ms: Optional[float] = None
    not_applicable: FrozenSet[str] = field(default_factory=frozenset)

    @property
    def unmeasured(self) -> FrozenSet[str]:
        """Columns with no reading that are *not* structurally absent."""
        return frozenset(
            name
            for name in self.columns
            if name not in self.not_applicable and self.phases.get(name) is None
        )

    @property
    def accounted_ms(self) -> float:
        """Sum of the phases that actually have a reading."""
        return round(
            sum(value for value in (self.phases.get(name) for name in self.columns) if value),
            1,
        )

    @property
    def residual_ms(self) -> float:
        """Measured startup the phases do not explain. Never negative."""
        if not self.measured_ms or self.measured_ms <= 0:
            return 0.0
        return round(max(0.0, self.measured_ms - self.accounted_ms), 1)

    @property
    def overcount_ms(self) -> float:
        """Phases in excess of the measured total. Never negative.

        Non-zero means two phases share a span somewhere — a modelling bug,
        but one an operator can only find if the column admits it.
        """
        if not self.measured_ms or self.measured_ms <= 0:
            return 0.0
        return round(max(0.0, self.accounted_ms - self.measured_ms), 1)

    def stage_names(self, columns: FrozenSet[str]) -> Tuple[str, ...]:
        return tuple(_STAGE_BY_COLUMN[name] for name in self.columns if name in columns)


@dataclass(frozen=True)
class StartupBudget:
    """One leg's startup decomposition, both halves."""

    publisher: StartupHalf
    player: StartupHalf

    @property
    def unmeasured_stages(self) -> Tuple[str, ...]:
        return (
            *self.publisher.stage_names(self.publisher.unmeasured),
            *self.player.stage_names(self.player.unmeasured),
        )

    @property
    def not_applicable_stages(self) -> Tuple[str, ...]:
        return (
            *self.publisher.stage_names(self.publisher.not_applicable),
            *self.player.stage_names(self.player.not_applicable),
        )

    def as_row(self) -> Dict[str, str]:
        row: Dict[str, str] = {}
        for half in (self.publisher, self.player):
            for name in half.columns:
                value = half.phases.get(name)
                # Blank, not 0: the CSV has to carry the difference between a
                # phase that took no time and a phase nothing measured.
                row[name] = "" if value is None else f"{value:.1f}"
        row["startup_publisher_accounted_ms"] = f"{self.publisher.accounted_ms:.1f}"
        row["startup_publisher_measured_ms"] = (
            "" if self.publisher.measured_ms is None else f"{self.publisher.measured_ms:.1f}"
        )
        row["startup_publisher_residual_ms"] = f"{self.publisher.residual_ms:.1f}"
        row["startup_publisher_overcount_ms"] = f"{self.publisher.overcount_ms:.1f}"
        row["startup_player_accounted_ms"] = f"{self.player.accounted_ms:.1f}"
        row["startup_player_measured_ms"] = (
            "" if self.player.measured_ms is None else f"{self.player.measured_ms:.1f}"
        )
        row["startup_player_residual_ms"] = f"{self.player.residual_ms:.1f}"
        row["startup_player_overcount_ms"] = f"{self.player.overcount_ms:.1f}"
        row["startup_unmeasured"] = ",".join(self.unmeasured_stages)
        row["startup_not_applicable"] = ",".join(self.not_applicable_stages)
        return row


def build_publisher_startup(
    *,
    protocol: Optional[str] = None,
    t0: Optional[float] = None,
    dns_done: Optional[float] = None,
    connect_done: Optional[float] = None,
    handshake_done: Optional[float] = None,
    publish_accepted: Optional[float] = None,
    first_idr: Optional[float] = None,
    first_byte_ingest: Optional[float] = None,
) -> StartupHalf:
    """Publisher chain from milestone timestamps (seconds, monotonic).

    Milestones are absolute instants; the phases between them are what gets
    reported. ``None`` for a milestone means it was never observed, which
    makes the phases on either side of it unmeasured.

    Phases marked not-applicable for the protocol are skipped when anchoring,
    so their successor spans the whole exchange. SRT has no connect, so its
    handshake is timed from ``dns_done`` — which is correct, because on SRT
    everything between name resolution and publish acceptance genuinely is the
    caller handshake.
    """
    absent = not_applicable_columns(protocol)
    milestones = {
        "startup_dns_ms": dns_done,
        "startup_connect_ms": connect_done,
        "startup_handshake_ms": handshake_done,
        "startup_publish_accept_ms": publish_accepted,
        "startup_first_idr_ms": first_idr,
        "startup_first_byte_ingest_ms": first_byte_ingest,
    }

    phases: Dict[str, Optional[float]] = {}
    anchor = t0
    # Whether ``anchor`` is the *immediately* preceding milestone. After a
    # missing milestone it is stale, and a duration measured from it would
    # span two phases. A not-applicable phase does not invalidate it: there
    # was never a milestone there to miss.
    anchor_fresh = t0 is not None
    for name in STARTUP_PUBLISHER_COMPONENTS:
        if name in absent:
            phases[name] = None
            continue
        end = milestones[name]
        phases[name] = _phase_between(anchor, end) if anchor_fresh else None
        if end is not None:
            anchor = end
            anchor_fresh = True
        else:
            anchor_fresh = False

    measured = _clean_phase_ms(
        None if (t0 is None or first_byte_ingest is None) else (first_byte_ingest - t0) * 1000.0,
        ceiling=_TOTAL_MAX_MS,
    )
    return StartupHalf(
        columns=STARTUP_PUBLISHER_COMPONENTS,
        phases=phases,
        measured_ms=measured,
        not_applicable=absent,
    )


def build_player_startup(
    *,
    engine: Optional[str] = None,
    request_ms: Optional[float] = None,
    manifest_ms: Optional[float] = None,
    first_media_ms: Optional[float] = None,
    first_paint_ms: Optional[float] = None,
    ttff_ms: Optional[float] = None,
) -> StartupHalf:
    """Player chain from phase durations the browser already computed.

    Unlike the publisher half this takes durations rather than milestones,
    because that is the shape the browser can produce honestly: Resource
    Timing hands back a set of marks on one request, and ``getStats()`` hands
    back transitions, neither of which shares a clock origin with the job.
    ``ttff_ms`` is the measured total the chain reconciles against.

    An engine with no manifest at all (raw MPEG-TS pull) reports the manifest
    phase as not-applicable rather than 0 ms.
    """
    key = (engine or "").strip().lower()
    absent = set()
    notes = PLAYER_PHASE_NOTES.get(key, {})
    for column, stage in zip(STARTUP_PLAYER_COMPONENTS, PLAYER_STAGE_NAMES):
        if key in PLAYER_PHASE_NOTES and notes.get(stage, "") == "":
            absent.add(column)

    phases: Dict[str, Optional[float]] = {
        "startup_player_request_ms": _clean_phase_ms(request_ms),
        "startup_manifest_ms": _clean_phase_ms(manifest_ms),
        "startup_first_media_ms": _clean_phase_ms(first_media_ms),
        "startup_first_paint_ms": _clean_phase_ms(first_paint_ms),
    }
    for column in absent:
        phases[column] = None

    return StartupHalf(
        columns=STARTUP_PLAYER_COMPONENTS,
        phases=phases,
        measured_ms=_clean_phase_ms(ttff_ms, ceiling=_TOTAL_MAX_MS),
        not_applicable=frozenset(absent),
    )


def build_startup_budget(
    *,
    protocol: Optional[str] = None,
    engine: Optional[str] = None,
    t0: Optional[float] = None,
    dns_done: Optional[float] = None,
    connect_done: Optional[float] = None,
    handshake_done: Optional[float] = None,
    publish_accepted: Optional[float] = None,
    first_idr: Optional[float] = None,
    first_byte_ingest: Optional[float] = None,
    player_request_ms: Optional[float] = None,
    player_manifest_ms: Optional[float] = None,
    player_first_media_ms: Optional[float] = None,
    player_first_paint_ms: Optional[float] = None,
    playback_ttff_ms: Optional[float] = None,
) -> StartupBudget:
    """Assemble both halves. See the module docstring for why they stay apart."""
    return StartupBudget(
        publisher=build_publisher_startup(
            protocol=protocol,
            t0=t0,
            dns_done=dns_done,
            connect_done=connect_done,
            handshake_done=handshake_done,
            publish_accepted=publish_accepted,
            first_idr=first_idr,
            first_byte_ingest=first_byte_ingest,
        ),
        player=build_player_startup(
            engine=engine,
            request_ms=player_request_ms,
            manifest_ms=player_manifest_ms,
            first_media_ms=player_first_media_ms,
            first_paint_ms=player_first_paint_ms,
            ttff_ms=playback_ttff_ms,
        ),
    )


def empty_startup_row() -> Dict[str, str]:
    """Blank startup columns, for rows written before anything was observed.

    Every value is the empty string rather than 0 — before the first milestone
    lands, nothing about startup has been *measured*, and a row of confident
    zeros would be indistinguishable from a leg that started instantly.
    """
    return {name: "" for name in STARTUP_COLUMNS}


__all__ = [
    "PLAYER_PHASE_NOTES",
    "PLAYER_STAGE_NAMES",
    "PROTOCOL_PHASE_NOTES",
    "PUBLISHER_STAGE_NAMES",
    "STAGE_NAMES",
    "STARTUP_COLUMNS",
    "STARTUP_COMPONENTS",
    "STARTUP_PLAYER_COMPONENTS",
    "STARTUP_PUBLISHER_COMPONENTS",
    "StartupBudget",
    "StartupHalf",
    "build_player_startup",
    "build_publisher_startup",
    "build_startup_budget",
    "empty_startup_row",
    "not_applicable_columns",
    "phase_note",
    "player_phase_note",
]
