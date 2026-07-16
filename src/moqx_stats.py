"""Poll the moqx relay's Prometheus /metrics endpoint during a MoQ run.

Mirrors the counters already parsed ad hoc by web/api/main.py's /api/moq/probe
diagnostic endpoint, but turns them into a continuous per-second time series
that feeds into the same results pipeline SRT gets from ZixiStatsPoller.
"""
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
        return self._latest

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
        )
