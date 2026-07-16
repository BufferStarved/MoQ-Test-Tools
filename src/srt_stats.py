import csv
import logging
import os
from dataclasses import dataclass, field
from typing import List, Optional

logger = logging.getLogger("MoQ-SRT-Bench")


@dataclass
class SrtStatsSnapshot:
    rtt_ms: float = 0.0
    rtt_jitter_ms: float = 0.0
    pkt_rcv_drop: int = 0
    pkt_snd_drop: int = 0
    pkt_rcv_loss: int = 0
    pkt_snd_loss: int = 0
    pkt_retrans: int = 0
    pkt_rcv_retrans: int = 0
    pkt_fec_extra: int = 0
    pkt_rcv_fec_extra: int = 0
    mbps_send_rate: float = 0.0
    mbps_recv_rate: float = 0.0


def _to_float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: str, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


class RttJitterTracker:
    """Track RTT samples and compute link jitter as stddev of RTT deltas."""

    def __init__(self, window: int = 30):
        self._window = window
        self._rtt_samples: List[float] = []

    def add(self, rtt_ms: float) -> float:
        self._rtt_samples.append(rtt_ms)
        if len(self._rtt_samples) > self._window:
            self._rtt_samples.pop(0)

        if len(self._rtt_samples) < 2:
            return 0.0

        deltas = [
            abs(self._rtt_samples[i] - self._rtt_samples[i - 1])
            for i in range(1, len(self._rtt_samples))
        ]
        return sum(deltas) / len(deltas)


class SrtStatsReader:
    """Reads incremental rows from srt-live-transmit -statsout CSV."""

    def __init__(self, stats_path: str):
        self._stats_path = stats_path
        self._header: Optional[List[str]] = None
        self._position = 0
        self._latest = SrtStatsSnapshot()
        self._jitter = RttJitterTracker()

    def poll(self) -> SrtStatsSnapshot:
        if not os.path.exists(self._stats_path):
            return self._latest

        try:
            with open(self._stats_path, mode="r", newline="") as file:
                file.seek(self._position)
                rows = list(csv.reader(file))
                self._position = file.tell()
        except OSError as exc:
            logger.warning("Could not read SRT stats file: %s", exc)
            return self._latest

        if not rows:
            return self._latest

        if self._header is None:
            self._header = rows[0]
            rows = rows[1:]

        if not self._header or not rows:
            return self._latest

        for row in rows:
            if len(row) != len(self._header):
                continue
            data = dict(zip(self._header, row))
            rtt_ms = _to_float(data.get("msRTT", "0"))
            self._latest = SrtStatsSnapshot(
                rtt_ms=rtt_ms,
                rtt_jitter_ms=self._jitter.add(rtt_ms),
                pkt_rcv_drop=_to_int(data.get("pktRcvDrop", "0")),
                pkt_snd_drop=_to_int(data.get("pktSndDrop", "0")),
                pkt_rcv_loss=_to_int(data.get("pktRcvLoss", "0")),
                pkt_snd_loss=_to_int(data.get("pktSndLoss", "0")),
                pkt_retrans=_to_int(data.get("pktRetrans", "0")),
                pkt_rcv_retrans=_to_int(data.get("pktRcvRetrans", "0")),
                pkt_fec_extra=_to_int(data.get("pktSndFilterExtra", "0")),
                pkt_rcv_fec_extra=_to_int(data.get("pktRcvFilterExtra", "0")),
                mbps_send_rate=_to_float(data.get("mbpsSendRate", "0")),
                mbps_recv_rate=_to_float(data.get("mbpsRecvRate", "0")),
            )

        return self._latest


@dataclass
class SrtStatsSummary:
    avg_rtt_ms: float = 0.0
    max_rtt_ms: float = 0.0
    avg_jitter_ms: float = 0.0
    max_jitter_ms: float = 0.0
    total_pkt_rcv_drop: int = 0
    total_pkt_snd_drop: int = 0
    total_pkt_retrans: int = 0
    total_pkt_fec_extra: int = 0
    samples: int = 0


def _row_value(row: dict, key: str, legacy_key: str = "") -> str:
    value = row.get(key)
    if value not in (None, ""):
        return str(value)
    if legacy_key:
        legacy = row.get(legacy_key)
        if legacy not in (None, ""):
            return str(legacy)
    return "0"


def summarize_srt_rows(rows: List[dict]) -> SrtStatsSummary:
    if not rows:
        return SrtStatsSummary()

    def avg(key: str, legacy_key: str = "") -> float:
        values = [float(_row_value(r, key, legacy_key)) for r in rows]
        return round(sum(values) / len(values), 3)

    def max_val(key: str, legacy_key: str = "") -> float:
        values = [float(_row_value(r, key, legacy_key)) for r in rows]
        return round(max(values), 3)

    def last_int(key: str, legacy_key: str = "") -> int:
        return int(float(_row_value(rows[-1], key, legacy_key)))

    return SrtStatsSummary(
        avg_rtt_ms=avg("transport_rtt_ms", "rtt_ms"),
        max_rtt_ms=max_val("transport_rtt_ms", "rtt_ms"),
        avg_jitter_ms=avg("transport_rtt_jitter_ms", "rtt_jitter_ms"),
        max_jitter_ms=max_val("transport_rtt_jitter_ms", "rtt_jitter_ms"),
        total_pkt_rcv_drop=last_int("pkt_rcv_drop"),
        total_pkt_snd_drop=last_int("pkt_snd_drop"),
        total_pkt_retrans=last_int("pkt_retrans"),
        total_pkt_fec_extra=last_int("pkt_fec_extra"),
        samples=len(rows),
    )
