"""Publisher-side instruments for the startup chain in ``startup_budget``.

``startup_budget`` defines *what* the six publisher phases mean; this module is
what actually reads a clock. It exists because the phases nearest the wire are
the only ones a Python sample loop can time directly — the rest have to be
inferred from signals that already exist (ffmpeg ``-progress``, the MediaMTX /
Zixi pollers, the moq5 publisher log), and inferring them badly is how a
decomposition starts lying.

Two instruments live here:

``probe_startup`` is a timed preflight. It resolves the ingest host and, where
the ingest actually runs over TCP, connects to it, taking ``time.monotonic()``
on either side of the syscall. This is the only part of the chain measured at
syscall resolution, and it is deliberately the first thing a job does so that
its ``t0`` is "job start" on every protocol rather than "whenever this
protocol's encoder happened to be spawned".

``StartupTracker`` is a one-shot recorder for the milestones the sample loop
observes, in the same spirit as ``metrics.UploadLatencyTracker``: first
observation wins, later ticks are free no-ops. First-observation-wins is not an
optimization, it is the measurement — startup happened once, and a signal that
stays true for the rest of the run (a MediaMTX path that is still ready at
t+29s) must not keep restamping its milestone.

**What this can and cannot see, honestly.**

The sample loops tick at 1 Hz (``sleep_until_next_tick``), so every milestone
observed *by polling* — first IDR, publish accepted, first byte at ingest — is
quantized to roughly one second, and its error is one-sided: the true instant
is somewhere in the second before we noticed. The phases derived from them are
therefore only trustworthy at second scale. That is still worth having: the
RTMP startup win this metric family exists to explain was 23 s → 1501 ms, a
difference 1 Hz resolves easily. It is not enough to compare two legs that
differ by 200 ms, and reporting it to 0.1 ms (which the CSV does, because the
DNS and connect phases genuinely have that precision) must not be mistaken for
0.1 ms accuracy on the polled phases.

DNS is exact but frequently near-zero, and that is correct rather than broken:
most benchmark destinations are IP literals (``34.9.217.178``), where
``getaddrinfo`` formats an address instead of asking a resolver. ``0.0`` there
means "measured, and there was nothing to resolve" — which is exactly the
distinction ``startup_budget`` keeps blank-vs-zero for.

TCP connect is measured only where the ingest transport is TCP. SRT and MoQ run
over UDP, so a TCP connect to their port would either be refused or, worse,
succeed against some unrelated listener and be charted as a transport connect
that never happened. SRT's absent connect is a structural n/a in the contract;
MoQ's ``connect`` phase means the QUIC handshake, which nothing in this process
can observe, so it stays unmeasured. Neither is filled with a stand-in.

There is no handshake instrument for RTMP, SRT or WHIP. ffmpeg does not report
when its RTMP C0/C1/S0/S1/S2 exchange, the SRT caller handshake or the WHIP
ICE/DTLS setup completed, and nothing else in the pipeline sees it. Those legs
report ``handshake`` as unmeasured, and — because ``build_publisher_startup``
refuses to stretch a neighbour across a missing milestone — the phase after it
is unmeasured too. A large residual with ``handshake`` named in
``startup_unmeasured`` is the honest shape of that gap; a confident 0 ms would
not be.
"""

from __future__ import annotations

import logging
import socket
import time
from dataclasses import dataclass
from typing import Callable, Dict, Optional
from urllib.parse import urlparse

from startup_budget import (
    STARTUP_PUBLISHER_COMPONENTS,
    StartupHalf,
    build_publisher_startup,
    empty_startup_row,
)

logger = logging.getLogger("MoQ-SRT-Bench")

# The preflight sits on the critical path of every join, so it gets a short
# leash. A slow connect is not worth a second of added TTFF to time precisely:
# on timeout the phase reports unmeasured and the encoder starts anyway, which
# is the right trade — the encode's own connect is the one that matters.
DEFAULT_PROBE_TIMEOUT_SEC = 1.5

# Port used when the URL omits one. Protocol first (MediaMTX serves WHIP on
# 8889, not 80), then scheme, so `http://host/whip` on a webrtc destination is
# probed where WHIP actually listens.
_PROTOCOL_PORTS: Dict[str, int] = {
    "rtmp": 1935,
    "webrtc": 8889,
    "srt": 8890,
    "moq": 443,
}
_SCHEME_PORTS: Dict[str, int] = {
    "rtmp": 1935,
    "rtmps": 443,
    "http": 80,
    "https": 443,
    "whip": 8889,
    "whips": 443,
    "srt": 8890,
}

# Schemes whose transport is not TCP. Connecting a TCP socket to one of these
# ports measures nothing about the session the encoder will open, and may
# succeed against a co-hosted TCP listener — a false reading is worse than a
# blank one.
_NON_TCP_SCHEMES = frozenset({"srt", "udp", "quic", "moqt", "moqs"})
_NON_TCP_PROTOCOLS = frozenset({"srt", "moq"})


@dataclass(frozen=True)
class StartupPreflight:
    """Milestone *instants* (monotonic seconds), not durations.

    The contract derives every phase from milestone differences, so handing it
    durations would mean computing them twice, in two places, from two
    conventions. ``t0`` is the job-start anchor the whole publisher chain is
    measured from.
    """

    t0: float
    dns_done: Optional[float] = None
    connect_done: Optional[float] = None
    host: str = ""
    port: int = 0
    tcp_applicable: bool = False
    dns_error: str = ""
    connect_error: str = ""


def resolve_probe_port(protocol: Optional[str], url: str) -> int:
    parsed = _safe_parse(url)
    if parsed is not None and parsed.port:
        return int(parsed.port)
    key = (protocol or "").strip().lower()
    if key in _PROTOCOL_PORTS:
        return _PROTOCOL_PORTS[key]
    scheme = (parsed.scheme if parsed is not None else "").lower()
    return _SCHEME_PORTS.get(scheme, 443)


def tcp_connect_applicable(protocol: Optional[str], url: str) -> bool:
    """Whether a TCP connect measures anything real for this destination."""
    if (protocol or "").strip().lower() in _NON_TCP_PROTOCOLS:
        return False
    parsed = _safe_parse(url)
    scheme = (parsed.scheme if parsed is not None else "").lower()
    return scheme not in _NON_TCP_SCHEMES


def _safe_parse(url: str):
    try:
        return urlparse((url or "").strip())
    except ValueError:
        return None


def probe_startup(
    protocol: Optional[str],
    url: str,
    *,
    timeout_sec: float = DEFAULT_PROBE_TIMEOUT_SEC,
    clock: Callable[[], float] = time.monotonic,
) -> StartupPreflight:
    """Time name resolution and (where applicable) the TCP connect.

    Costs one resolve plus, on TCP legs, one round trip of added join time
    (~30-60 ms to a cloud ingest). That buys the only two phases in the chain
    measured at syscall rather than sample-loop resolution, on a metric whose
    reason for existing was a 23 s startup nobody could attribute.

    Never raises: a job must not fail because its startup instrument did. A
    resolve or connect that errors leaves the corresponding milestone ``None``,
    which the contract reports as an unmeasured phase — the same state as
    "no instrument here", and for the same reason (we do not know how long it
    took, only that we did not measure it).
    """
    t0 = clock()
    parsed = _safe_parse(url)
    host = (parsed.hostname or "").strip() if parsed is not None else ""
    if not host:
        return StartupPreflight(t0=t0, dns_error=f"URL has no host: {url!r}")

    port = resolve_probe_port(protocol, url)
    tcp_ok = tcp_connect_applicable(protocol, url)

    dns_done: Optional[float] = None
    dns_error = ""
    try:
        socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        dns_done = clock()
    except (OSError, ValueError) as exc:
        dns_error = f"getaddrinfo({host}:{port}) failed: {exc}"
        logger.debug("startup preflight: %s", dns_error)

    connect_done: Optional[float] = None
    connect_error = ""
    if tcp_ok and dns_done is not None:
        try:
            with socket.create_connection((host, port), timeout=timeout_sec):
                connect_done = clock()
        except (OSError, ValueError) as exc:
            connect_error = f"TCP connect to {host}:{port} failed: {exc}"
            logger.debug("startup preflight: %s", connect_error)

    return StartupPreflight(
        t0=t0,
        dns_done=dns_done,
        connect_done=connect_done,
        host=host,
        port=port,
        tcp_applicable=tcp_ok,
        dns_error=dns_error,
        connect_error=connect_error,
    )


class StartupTracker:
    """One-shot milestone recorder for a single publish attempt.

    Each ``note_*`` takes the boolean the sample loop already computes and
    stamps a monotonic instant the first time it is true. Later ticks are
    ignored: the signals feeding this are level, not edge — ``mtx.ready`` stays
    true, ``live: sent track=`` stays in the log tail — so without the one-shot
    the "milestone" would track the last sample instead of the first.

    A retried publish (the RTMP early-exit retry in ``upload_service``) is a
    new startup, not a continuation, and gets a new tracker with a new ``t0``.
    """

    def __init__(
        self,
        protocol: Optional[str] = None,
        *,
        t0: Optional[float] = None,
        preflight: Optional[StartupPreflight] = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.protocol = (protocol or "").strip().lower()
        self._clock = clock
        if t0 is not None:
            self._t0: Optional[float] = t0
        elif preflight is not None:
            self._t0 = preflight.t0
        else:
            self._t0 = clock()
        self._dns_done = preflight.dns_done if preflight is not None else None
        self._connect_done = preflight.connect_done if preflight is not None else None
        self._handshake_done: Optional[float] = None
        self._publish_accepted: Optional[float] = None
        self._first_idr: Optional[float] = None
        self._first_byte_ingest: Optional[float] = None

    # -- milestone recorders -------------------------------------------------

    def note_handshake(self, observed: bool) -> None:
        if observed and self._handshake_done is None:
            self._handshake_done = self._clock()

    def note_publish_accepted(self, observed: bool) -> None:
        if observed and self._publish_accepted is None:
            self._publish_accepted = self._clock()

    def note_first_idr(self, encode_frames: int) -> None:
        """First encoded frame, read off ffmpeg ``-progress`` ``frame=N``.

        ``frame >= 1`` is the cheapest honest first-IDR signal available: for
        H.264 the first frame an encoder emits is always an IDR, so the frame
        counter leaving 0 *is* the first IDR. It is quantized to the 1 Hz
        sample loop and biased late — the frame existed somewhere in the second
        before we looked.
        """
        try:
            frames = int(encode_frames or 0)
        except (TypeError, ValueError):
            return
        if frames >= 1 and self._first_idr is None:
            self._first_idr = self._clock()

    def note_first_byte_ingest(self, observed: bool) -> None:
        if observed and self._first_byte_ingest is None:
            self._first_byte_ingest = self._clock()

    def observe(
        self,
        *,
        encode_frames: int = 0,
        handshake: bool = False,
        publish_accepted: bool = False,
        first_byte_ingest: bool = False,
    ) -> StartupHalf:
        """Record this tick's signals and return the current publisher half.

        Milestones are recorded in chain order so that two signals arriving on
        the same tick keep their ordering rather than depending on keyword
        order. Same-tick arrivals produce a 0.0 ms phase, which is a real
        reading at 1 Hz resolution and not a missing one.
        """
        self.note_handshake(handshake)
        self.note_publish_accepted(publish_accepted)
        self.note_first_idr(encode_frames)
        self.note_first_byte_ingest(first_byte_ingest)
        return self.publisher_half()

    # -- readouts -----------------------------------------------------------

    @property
    def t0(self) -> Optional[float]:
        return self._t0

    def milestones(self) -> Dict[str, Optional[float]]:
        return {
            "t0": self._t0,
            "dns_done": self._dns_done,
            "connect_done": self._connect_done,
            "handshake_done": self._handshake_done,
            "publish_accepted": self._publish_accepted,
            "first_idr": self._first_idr,
            "first_byte_ingest": self._first_byte_ingest,
        }

    def publisher_half(self) -> StartupHalf:
        return build_publisher_startup(
            protocol=self.protocol,
            t0=self._t0,
            dns_done=self._dns_done,
            connect_done=self._connect_done,
            handshake_done=self._handshake_done,
            publish_accepted=self._publish_accepted,
            first_idr=self._first_idr,
            first_byte_ingest=self._first_byte_ingest,
        )


def publisher_startup_row(half: Optional[StartupHalf]) -> Dict[str, str]:
    """Full startup column block with only the publisher half filled in.

    Starts from ``empty_startup_row`` so every column is present and blank —
    the CSV must never be missing a startup column, and a column nothing has
    measured yet must be blank rather than 0. The player columns stay blank
    here on purpose: the encoder loop has no player attached, and they are
    filled later from playback data.

    ``startup_unmeasured`` / ``startup_not_applicable`` carry only publisher
    stages for the same reason — naming the player stages from a process that
    cannot see a player would report a gap in someone else's instrument.
    """
    row = empty_startup_row()
    if half is None:
        return row
    for name in STARTUP_PUBLISHER_COMPONENTS:
        value = half.phases.get(name)
        row[name] = "" if value is None else f"{value:.1f}"
    row["startup_publisher_accounted_ms"] = f"{half.accounted_ms:.1f}"
    row["startup_publisher_measured_ms"] = (
        "" if half.measured_ms is None else f"{half.measured_ms:.1f}"
    )
    row["startup_publisher_residual_ms"] = f"{half.residual_ms:.1f}"
    row["startup_publisher_overcount_ms"] = f"{half.overcount_ms:.1f}"
    row["startup_unmeasured"] = ",".join(half.stage_names(half.unmeasured))
    row["startup_not_applicable"] = ",".join(half.stage_names(half.not_applicable))
    return row


__all__ = [
    "DEFAULT_PROBE_TIMEOUT_SEC",
    "StartupPreflight",
    "StartupTracker",
    "probe_startup",
    "publisher_startup_row",
    "resolve_probe_port",
    "tcp_connect_applicable",
]
