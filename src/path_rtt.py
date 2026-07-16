"""Active path RTT probe used when a transport has no native RTT instrument.

Used when the publish path lacks a peer RTT gauge:

- MoQ: openmoq has no qlog; moqx Prometheus lacks smoothed RTT. Probe the
  relay admin HTTP port (same host as WebTransport).
- RTMP: ffmpeg→RTMP has no libsrt-style RTT. Probe TCP connect to the RTMP
  host:port (typically 1935) as a path RTT stand-in.

Jitter is derived from successive samples with the same estimator as libsrt.
"""
from __future__ import annotations

import logging
import os
import socket
import time
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

from srt_stats import RttJitterTracker

logger = logging.getLogger("MoQ-SRT-Bench")


@dataclass
class PathRttSnapshot:
    rtt_ms: float = 0.0
    jitter_ms: float = 0.0
    source: str = ""


class PathRttProbe:
    """Measure TCP connect RTT to a host:port once per poll."""

    def __init__(
        self,
        endpoint_url: str,
        *,
        port: Optional[int] = None,
        timeout_sec: float = 1.5,
    ):
        parsed = urlparse(endpoint_url.strip())
        self._host = parsed.hostname or ""
        # Prefer explicit override; else admin HTTP (8000) on the relay VM —
        # TCP to the QUIC/WebTransport port usually gets no SYN-ACK.
        self._port = int(port or 0) or int(os.environ.get("MOQX_ADMIN_PORT", "8000"))
        self._timeout_sec = timeout_sec
        self._jitter = RttJitterTracker()
        self._latest = PathRttSnapshot()
        self._enabled = bool(self._host and self._port > 0)

    @property
    def enabled(self) -> bool:
        return self._enabled

    def poll(self) -> PathRttSnapshot:
        if not self._enabled:
            return self._latest

        started = time.perf_counter()
        try:
            with socket.create_connection(
                (self._host, self._port),
                timeout=self._timeout_sec,
            ):
                pass
            rtt_ms = (time.perf_counter() - started) * 1000.0
        except OSError as exc:
            logger.debug(
                "Path RTT probe failed for %s:%s: %s",
                self._host,
                self._port,
                exc,
            )
            return self._latest

        if rtt_ms <= 0:
            return self._latest

        jitter_ms = self._jitter.add(rtt_ms)
        self._latest = PathRttSnapshot(
            rtt_ms=round(rtt_ms, 3),
            jitter_ms=round(jitter_ms, 3),
            source=f"tcp://{self._host}:{self._port}",
        )
        return self._latest
