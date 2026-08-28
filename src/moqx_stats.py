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
CANARY_ADMIN_PORT = int(os.environ.get("MOQX_CANARY_ADMIN_PORT", "18000"))
CANARY_WT_PORT = 14433


def admin_port_for_endpoint(endpoint_url: str) -> int:
    """Admin HTTP port for this WebTransport URL.

    Prod moqx is UDP 4433 + TCP 8000. The draft-18 canary is UDP 14433 +
    TCP 18000. Scraping :8000 for a :14433 publish watches the *other*
    container and reports a false 'never announced'.
    """
    port = urlparse(endpoint_url).port
    if port == CANARY_WT_PORT:
        return CANARY_ADMIN_PORT
    return DEFAULT_ADMIN_PORT


def admin_host_for_endpoint(endpoint_url: str) -> str:
    """Dotted IPv4 for sslip.io relays so /metrics hits the VM, not the name."""
    host = urlparse(endpoint_url).hostname or ""
    if host.endswith(".sslip.io"):
        dashed = host.split(".")[0]
        parts = dashed.split("-")
        if len(parts) == 4 and all(part.isdigit() for part in parts):
            return ".".join(parts)
    return host


def admin_base_url_for_endpoint(endpoint_url: str) -> str:
    host = admin_host_for_endpoint(endpoint_url)
    if not host:
        return ""
    return f"http://{host}:{admin_port_for_endpoint(endpoint_url)}"


@dataclass
class MoqxStatsSnapshot:
    subscribe_success: int = 0
    subscribe_error: int = 0
    subscribe_error_track_not_exist: int = 0
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

        base = admin_base_url_for_endpoint(endpoint_url)
        if not base:
            return
        self._metrics_url = f"{base}/metrics"
        self._enabled = True

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def observing(self) -> bool:
        """True once /metrics has been scraped at least once this job.

        `enabled` is just "we know which URL to hit". An east/Linode relay
        whose admin port is firewalled from the encode host used to look
        identical to a live poller, so a no-timeout preview gate would stall
        forever. Treat unreachable metrics as "no poller".
        """
        return self._enabled and self._baseline is not None

    def poll(self) -> MoqxStatsSnapshot:
        if not self._enabled:
            return self._latest

        try:
            request = urllib.request.Request(self._metrics_url)
            with urllib.request.urlopen(request, timeout=0.8) as response:
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
                subscribe_success=self._latest.subscribe_success,
                subscribe_error=self._latest.subscribe_error,
                subscribe_error_track_not_exist=self._latest.subscribe_error_track_not_exist,
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
            subscribe_success=max(0, current.subscribe_success - base.subscribe_success),
            subscribe_error=max(0, current.subscribe_error - base.subscribe_error),
            subscribe_error_track_not_exist=max(
                0,
                current.subscribe_error_track_not_exist - base.subscribe_error_track_not_exist,
            ),
            publish_namespace_success=max(
                0, current.publish_namespace_success - base.publish_namespace_success
            ),
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
    def _metric_value(body: str, name: str, labels: str = "") -> int:
        return metric_value(body, name, labels)

    def _parse(self, body: str) -> MoqxStatsSnapshot:
        return parse_moqx_metrics(body)


@dataclass
class MoqxBaseline:
    quic_packet_loss: int = 0
    quic_packet_retransmissions: int = 0
    quic_packets_sent: int = 0
    quic_bytes_written: int = 0
    publish_namespace_success: int = 0
    subscribe_success: int = 0
    subscribe_error: int = 0
    subscribe_error_track_not_exist: int = 0


def metric_value(body: str, name: str, labels: str = "") -> int:
    """Parse one Prometheus counter. Shared by the poller and /api/moq/probe."""
    for line in body.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        if labels:
            if f"{name}{{{labels}" not in line:
                continue
        elif not (line.startswith(f"{name} ") or line.startswith(f"{name}{{")):
            continue
        try:
            return int(float(line.rsplit(" ", 1)[-1]))
        except ValueError:
            return 0
    return 0


def parse_moqx_metrics(body: str) -> MoqxStatsSnapshot:
    """Lifetime moqx /metrics body → snapshot (same fields job samples use)."""
    return MoqxStatsSnapshot(
        subscribe_success=metric_value(body, "moqx_pubSubscribeSuccess_total"),
        subscribe_error=metric_value(body, "moqx_pubSubscribeError_total"),
        subscribe_error_track_not_exist=metric_value(
            body,
            "moqx_pubSubscribeError_by_code_total",
            'code="track_not_exist"',
        ),
        # moqx prefixes counters by the *relay's* role in that session:
        # a publisher's PUBLISH_NAMESPACE lands on the relay's
        # subscriber-side handler (sub*), not pub*. On the live relay
        # moqx_pubPublishNamespaceSuccess_total is permanently 0 while
        # moqx_subPublishNamespaceSuccess_total counts every real publish
        # (verified 2026-07-20). Reading only pub* made the MoQ
        # preview-ready gate never confirm, so every live run silently
        # burned the full fallback grace period before playback started.
        # Sum both so either relay build/version works.
        publish_namespace_success=(
            metric_value(body, "moqx_pubPublishNamespaceSuccess_total")
            + metric_value(body, "moqx_subPublishNamespaceSuccess_total")
        ),
        publish_received=metric_value(body, "moqx_moqPublishReceived_total"),
        publish_done=metric_value(body, "moqx_pubPublishDone_total"),
        quic_packets_sent=metric_value(body, "moqx_quicPacketsSent_total"),
        quic_packets_received=metric_value(body, "moqx_quicPacketsReceived_total"),
        quic_packet_loss=metric_value(body, "moqx_quicPacketLoss_total"),
        quic_packet_retransmissions=metric_value(
            body, "moqx_quicPacketRetransmissions_total"
        ),
        quic_bytes_written=metric_value(body, "moqx_quicBytesWritten_total"),
        quic_bytes_read=metric_value(body, "moqx_quicBytesRead_total"),
    )


def snapshot_delta(current: MoqxStatsSnapshot, base: MoqxStatsSnapshot) -> MoqxStatsSnapshot:
    """Subtract two lifetime scrapes (since-last-probe / job-window)."""
    return MoqxStatsSnapshot(
        subscribe_success=max(0, current.subscribe_success - base.subscribe_success),
        subscribe_error=max(0, current.subscribe_error - base.subscribe_error),
        subscribe_error_track_not_exist=max(
            0,
            current.subscribe_error_track_not_exist - base.subscribe_error_track_not_exist,
        ),
        publish_namespace_success=max(
            0, current.publish_namespace_success - base.publish_namespace_success
        ),
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


def publish_seen(snap: MoqxStatsSnapshot) -> bool:
    """True when this scrape shows a publisher has registered or sent."""
    return (
        snap.publish_namespace_success > 0
        or snap.publish_received > 0
        or snap.publish_done > 0
    )


def interpret_moqx_probe(
    lifetime: MoqxStatsSnapshot,
    window: MoqxStatsSnapshot,
    *,
    had_prior_probe: bool,
) -> list[str]:
    """Verdicts for /api/moq/probe.

    Lifetime ``track_not_exist`` is historical on a busy relay and must not
    become ``relay_playback_broken`` once a publish has been seen, or when
    the since-last-probe / job window shows no new 0x10 errors.
    """
    checks: list[str] = []
    lifetime_publish = publish_seen(lifetime)
    window_tne = window.subscribe_error_track_not_exist
    window_failing = (
        had_prior_probe
        and window.subscribe_success == 0
        and window.subscribe_error > 0
        and not lifetime_publish
    )

    # Lifetime TNE on a reused relay is historical. Only the since-last-probe
    # window can claim a *current* subscribe-before-publish failure.
    if had_prior_probe and window_tne > 0 and not lifetime_publish:
        checks.append("subscribe_track_not_exist")
    elif lifetime.subscribe_error_track_not_exist > 0:
        checks.append("historical_track_not_exist")

    if lifetime.publish_namespace_success == 0 and not lifetime_publish:
        checks.append("publish_never_received")
    if window_failing:
        checks.append("subscribe_always_fails")

    broken = {"subscribe_track_not_exist", "publish_never_received", "subscribe_always_fails"}
    if broken.intersection(checks) and not lifetime_publish:
        checks.append("relay_playback_broken")
    elif not broken.intersection(checks):
        checks.append("relay_metrics_look_healthy")
    return checks


def snapshot_as_probe_dict(snap: MoqxStatsSnapshot) -> dict:
    return {
        "subscribe_success": snap.subscribe_success,
        "subscribe_error": snap.subscribe_error,
        "subscribe_error_track_not_exist": snap.subscribe_error_track_not_exist,
        "publish_namespace_success": snap.publish_namespace_success,
        "publish_received": snap.publish_received,
        "publish_done": snap.publish_done,
        "quic_packet_loss": snap.quic_packet_loss,
        "quic_packet_retransmissions": snap.quic_packet_retransmissions,
        "quic_bytes_written": snap.quic_bytes_written,
        "quic_bytes_read": snap.quic_bytes_read,
    }


_LAST_PROBE: dict[str, MoqxStatsSnapshot] = {}


def remember_probe(metrics_url: str, snap: MoqxStatsSnapshot) -> MoqxStatsSnapshot | None:
    """Store this scrape and return the previous one for since-last-probe deltas."""
    previous = _LAST_PROBE.get(metrics_url)
    _LAST_PROBE[metrics_url] = snap
    return previous
