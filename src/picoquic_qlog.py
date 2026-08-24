"""Tail picoquic autoqlog output for QUIC RTT, congestion window, and loss.

moq5-fmp4-publish sets MOQ_QLOG_DIR; the local libmoq hook calls
picoquic_set_qlog() from ep_configure_quic so each connection writes a
*.client.qlog JSON trace while the ingest is live. This module polls the
newest file and extracts recovery/metrics_updated (µs → ms).

picoquic only writes *changed* fields, so a later event may have cwnd
without smoothed_rtt — the parser carries the last seen RTT forward.
Jitter is the mean absolute delta of successive RTT samples (same
estimator as libsrt / PathRttProbe), never a TCP admin-port probe.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

logger = logging.getLogger("MoQ-SRT-Bench")

# Live picoquic array events:
#   [45228,"recovery","metrics_updated","default",{"smoothed_rtt":46151,...}]
#   [45228,0,"recovery","metrics_updated",{"latest_rtt":46151,"cwnd":12154}]
_METRICS_ARRAY_RE = re.compile(
    r'\[\s*[^\]]*?,\s*"recovery"\s*,\s*"metrics_updated"[^\[]*?\{([^}]*)\}',
)
# JSON-SEQ / object events (qlog-02 and some converters).
_METRICS_OBJECT_RE = re.compile(
    r'(?:'
    r'"name"\s*:\s*"recovery:metrics_updated"'
    r'|'
    r'"name"\s*:\s*"metrics_updated"'
    r').{0,400}?"data"\s*:\s*\{([^}]*)\}',
    re.DOTALL,
)
_SMOOTHED_RTT_RE = re.compile(r'"smoothed_rtt"\s*:\s*(\d+)')
_LATEST_RTT_RE = re.compile(r'"latest_rtt"\s*:\s*(\d+)')
_CWND_RE = re.compile(r'"cwnd"\s*:\s*(\d+)')
_PACKET_LOST_RE = re.compile(
    r'"recovery"\s*,\s*"packet_lost"|"name"\s*:\s*"recovery:packet_lost"'
)


@dataclass
class PicoquicQlogSnapshot:
    rtt_ms: float = 0.0
    jitter_ms: float = 0.0
    cwnd_bytes: int = 0
    packets_lost: int = 0


def _iter_metrics_blocks(content: str) -> Iterable[str]:
    for match in _METRICS_ARRAY_RE.finditer(content):
        yield match.group(1)
    for match in _METRICS_OBJECT_RE.finditer(content):
        yield match.group(1)


def _jitter_ms(samples_ms: list[float]) -> float:
    if len(samples_ms) < 2:
        return 0.0
    window = samples_ms[-30:]
    deltas = [abs(window[i] - window[i - 1]) for i in range(1, len(window))]
    return round(sum(deltas) / len(deltas), 3)


def parse_qlog_metrics(content: str) -> PicoquicQlogSnapshot:
    """Parse picoquic recovery/metrics_updated events from a qlog fragment."""
    last_smoothed_us = 0
    last_latest_us = 0
    last_cwnd = 0
    rtt_samples_ms: list[float] = []

    for block in _iter_metrics_blocks(content):
        smoothed = _SMOOTHED_RTT_RE.search(block)
        latest = _LATEST_RTT_RE.search(block)
        cwnd = _CWND_RE.search(block)
        if smoothed:
            last_smoothed_us = int(smoothed.group(1))
        if latest:
            last_latest_us = int(latest.group(1))
        if cwnd:
            last_cwnd = int(cwnd.group(1))
        sample_us = last_latest_us or last_smoothed_us
        if sample_us > 0:
            rtt_samples_ms.append(round(sample_us / 1000.0, 3))

    rtt_us = last_smoothed_us or last_latest_us
    return PicoquicQlogSnapshot(
        rtt_ms=round(rtt_us / 1000.0, 3) if rtt_us > 0 else 0.0,
        jitter_ms=_jitter_ms(rtt_samples_ms),
        cwnd_bytes=last_cwnd,
        packets_lost=len(_PACKET_LOST_RE.findall(content)),
    )


class PicoquicQlogTailer:
    """Poll the newest qlog file in a directory for transport metrics."""

    def __init__(self, qlog_dir: str):
        self._qlog_dir = qlog_dir
        self._enabled = bool(qlog_dir)
        self._latest = PicoquicQlogSnapshot()

    @property
    def enabled(self) -> bool:
        return self._enabled

    def poll(self) -> PicoquicQlogSnapshot:
        if not self._enabled:
            return self._latest

        path = self._find_latest_qlog()
        if path is None:
            return self._latest

        try:
            content = self._read_tail(path)
        except OSError as exc:
            logger.debug("qlog tail failed for %s: %s", path, exc)
            return self._latest

        snapshot = parse_qlog_metrics(content)
        if snapshot.rtt_ms > 0 or snapshot.cwnd_bytes > 0 or snapshot.packets_lost > 0:
            self._latest = snapshot
        return self._latest

    def _find_latest_qlog(self) -> Optional[str]:
        root = Path(self._qlog_dir)
        if not root.is_dir():
            return None

        candidates = list(root.glob("*.qlog")) + list(root.glob("*.sqlog"))
        if not candidates:
            candidates = list(root.rglob("*.qlog"))
        if not candidates:
            return None

        candidates.sort(key=lambda item: item.stat().st_mtime, reverse=True)
        return str(candidates[0])

    @staticmethod
    def _read_tail(path: str, max_bytes: int = 512_000) -> str:
        size = os.path.getsize(path)
        with open(path, mode="rb") as handle:
            if size > max_bytes:
                handle.seek(size - max_bytes)
            data = handle.read()
        return data.decode("utf-8", errors="replace")
