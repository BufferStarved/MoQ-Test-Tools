"""Poll the moqx relay's Prometheus /metrics endpoint during a MoQ run.

Mirrors the counters already parsed ad hoc by web/api/main.py's /api/moq/probe
diagnostic endpoint, but turns them into a continuous per-second time series
that feeds into the same results pipeline SRT gets from ZixiStatsPoller.

Also collects QUIC transport counters (loss / retransmits / bytes) so MoQ can
populate normalized net_loss_pct / net_retrans_pct alongside SRT.
"""
from __future__ import annotations

import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import urlparse

logger = logging.getLogger("MoQ-SRT-Bench")

DEFAULT_ADMIN_PORT = int(os.environ.get("MOQX_ADMIN_PORT", "8000"))


@dataclass
class MoqxStatsSnapshot:
    subscribe_success: int = 0
    subscribe_error: int = 0
    publish_namespace_success: int = 0
    publish_received: int = 0
    publish_done: int = 0
    quic_packets_sent: int = 0
    quic_packets_received: int = 0
    quic_packet_loss: int = 0
    quic_packet_retransmissions: int = 0
    quic_bytes_written: int = 0
    quic_bytes_read: int = 0


class MoqxStatsPoller:
    """
    Relay-side stats from moqx's Prometheus /metrics endpoint.

    Configure with environment variables:
      MOQX_ADMIN_URL   full override, e.g. http://34.28.164.90:8000
      MOQX_ADMIN_PORT  admin port to use when deriving the URL from the
                        MoQ endpoint host (default 8000)
    """

    def __init__(self, endpoint_url: str):
        self._latest = MoqxStatsSnapshot()
        self._metrics_url = ""
        self._enabled = False
        self._baseline: MoqxBaseline | None = None

        explicit = os.environ.get("MOQX_ADMIN_URL", "").rstrip("/")
        if explicit:
            self._metrics_url = f"{explicit}/metrics"
            self._enabled = True
            return

        host = urlparse(endpoint_url).hostname
        if not host:
            return

        self._metrics_url = f"http://{host}:{DEFAULT_ADMIN_PORT}/metrics"
        self._enabled = True

    @property
    def enabled(self) -> bool:
        return self._enabled

    def poll(self) -> MoqxStatsSnapshot:
        if not self._enabled:
            return self._latest

        try:
            request = urllib.request.Request(self._metrics_url)
            with urllib.request.urlopen(request, timeout=3) as response:
                body = response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.debug("moqx relay stats unavailable at %s: %s", self._metrics_url, exc)
            return self._latest

        self._latest = self._parse(body)
        if self._baseline is None:
            self._baseline = MoqxBaseline(
                quic_packet_loss=self._latest.quic_packet_loss,
                quic_packet_retransmissions=self._latest.quic_packet_retransmissions,
                quic_packets_sent=self._latest.quic_packets_sent,
                quic_bytes_written=self._latest.quic_bytes_written,
                publish_namespace_success=self._latest.publish_namespace_success,
            )
        return self._latest

    def publish_namespace_success_delta(self) -> int:
        """This job's own successful namespace publishes since baseline.

        moqx's Prometheus counters are relay-lifetime cumulative, not scoped
        to a namespace/session — a busy relay can already show 50+ successes
        before this job's publisher even connects. Callers use this to detect
        "did *this* job's publish actually go live" without needing a
        per-namespace metric from moqx.
        """
        if self._baseline is None:
            return 0
        return max(0, self._latest.publish_namespace_success - self._baseline.publish_namespace_success)

    def job_window_deltas(self) -> MoqxStatsSnapshot:
        """Return QUIC counters relative to the first successful poll in this job."""
        current = self._latest
        base = self._baseline
        if base is None:
            return current
        return MoqxStatsSnapshot(
            subscribe_success=current.subscribe_success,
            subscribe_error=current.subscribe_error,
            publish_namespace_success=current.publish_namespace_success,
            publish_received=current.publish_received,
            publish_done=current.publish_done,
            quic_packets_sent=max(0, current.quic_packets_sent - base.quic_packets_sent),
            quic_packets_received=current.quic_packets_received,
            quic_packet_loss=max(0, current.quic_packet_loss - base.quic_packet_loss),
            quic_packet_retransmissions=max(
                0, current.quic_packet_retransmissions - base.quic_packet_retransmissions
            ),
            quic_bytes_written=max(0, current.quic_bytes_written - base.quic_bytes_written),
            quic_bytes_read=current.quic_bytes_read,
        )

    @staticmethod
    def _metric_value(body: str, name: str) -> int:
        for line in body.splitlines():
            if line.startswith("#") or not line.strip():
                continue
            if line.startswith(f"{name} ") or line.startswith(f"{name}{{"):
                try:
                    return int(float(line.rsplit(" ", 1)[-1]))
                except ValueError:
                    return 0
        return 0

    def _parse(self, body: str) -> MoqxStatsSnapshot:
        return MoqxStatsSnapshot(
            subscribe_success=self._metric_value(body, "moqx_pubSubscribeSuccess_total"),
            subscribe_error=self._metric_value(body, "moqx_pubSubscribeError_total"),
            publish_namespace_success=self._metric_value(
                body, "moqx_pubPublishNamespaceSuccess_total"
            ),
            publish_received=self._metric_value(body, "moqx_moqPublishReceived_total"),
            publish_done=self._metric_value(body, "moqx_pubPublishDone_total"),
            quic_packets_sent=self._metric_value(body, "moqx_quicPacketsSent_total"),
            quic_packets_received=self._metric_value(body, "moqx_quicPacketsReceived_total"),
            quic_packet_loss=self._metric_value(body, "moqx_quicPacketLoss_total"),
            quic_packet_retransmissions=self._metric_value(
                body, "moqx_quicPacketRetransmissions_total"
            ),
            quic_bytes_written=self._metric_value(body, "moqx_quicBytesWritten_total"),
            quic_bytes_read=self._metric_value(body, "moqx_quicBytesRead_total"),
        )


@dataclass
class MoqxBaseline:
    quic_packet_loss: int = 0
    quic_packet_retransmissions: int = 0
    quic_packets_sent: int = 0
    quic_bytes_written: int = 0
    publish_namespace_success: int = 0
