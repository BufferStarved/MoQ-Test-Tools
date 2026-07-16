"""Tail picoquic autoqlog output for QUIC RTT, congestion window, and loss.

moq5-fmp4-publish enables picoquic_set_qlog() when started with --qlog-dir.
Each connection writes a *.client.qlog JSON trace; this module polls the
newest file and extracts the latest recovery/metrics_updated sample plus a
running packet_lost count.
"""
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

logger = logging.getLogger("MoQ-SRT-Bench")

_METRICS_EVENT_RE = re.compile(
    r'\[[^\]]+,\s*"recovery",\s*"metrics_updated"[^\]]*\{([^}]*)\}\]',
)
_SMOOTHED_RTT_RE = re.compile(r'"smoothed_rtt"\s*:\s*(\d+)')
_CWND_RE = re.compile(r'"cwnd"\s*:\s*(\d+)')
_PACKET_LOST_RE = re.compile(r'"recovery",\s*"packet_lost"')


@dataclass
class PicoquicQlogSnapshot:
    rtt_ms: float = 0.0
    cwnd_bytes: int = 0
    packets_lost: int = 0


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

        rtt_us, cwnd = self._parse_latest_metrics(content)
        packets_lost = len(_PACKET_LOST_RE.findall(content))
        self._latest = PicoquicQlogSnapshot(
            rtt_ms=round(rtt_us / 1000.0, 3) if rtt_us > 0 else 0.0,
            cwnd_bytes=cwnd,
            packets_lost=packets_lost,
        )
        return self._latest

    def _find_latest_qlog(self) -> Optional[str]:
        root = Path(self._qlog_dir)
        if not root.is_dir():
            return None

        candidates = list(root.glob("*.qlog"))
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

    @staticmethod
    def _parse_latest_metrics(content: str) -> tuple[int, int]:
        rtt_us = 0
        cwnd = 0
        for match in _METRICS_EVENT_RE.finditer(content):
            block = match.group(1)
            rtt_match = _SMOOTHED_RTT_RE.search(block)
            cwnd_match = _CWND_RE.search(block)
            if rtt_match:
                rtt_us = int(rtt_match.group(1))
            if cwnd_match:
                cwnd = int(cwnd_match.group(1))
        return rtt_us, cwnd
