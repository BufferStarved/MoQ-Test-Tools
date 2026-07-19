import logging
from dataclasses import dataclass

from gcp_host_metrics import GcpHostMetricsPoller
from ingest_agent_client import IngestAgentClient, resolve_ingest_agent
from system_metrics import read_client_host_metrics

logger = logging.getLogger("MoQ-SRT-Bench")


@dataclass
class IngestHostMetricsSnapshot:
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    disk_percent: float = 0.0
    source: str = ""


class IngestHostMetricsPoller:
    """Host health for the destination edge VM.

    - Zixi / shared ingest worker: prefer ingest-agent psutil, GCP as fallback.
    - MoQ relay: prefer GCP Cloud Monitoring for the relay instance (the ingest
      agent often lives on the Zixi worker, not the relay).
    - MediaMTX (co-located on moq-web): local psutil only — never probe a remote
      ingest-agent or GCP Monitoring in the sample loop (those hang ~10s and
      starve preview_ready / CSV sampling).
    """

    def __init__(
        self,
        endpoint_url: str,
        *,
        agent_url: str = "",
        ingest_provider: str = "",
    ):
        self._ingest_provider = (ingest_provider or "").strip().lower()
        # MediaMTX runs on the same VM as the bench API — local metrics only.
        self._use_local = self._ingest_provider == "gcp_mediamtx"
        if self._use_local:
            self._config = None
            self._client = None
            self._gcp = GcpHostMetricsPoller(ingest_provider="", endpoint_url="")
            self._gcp.enabled = False
            self.enabled = True
            self._prefer_gcp = False
            return

        self._config = resolve_ingest_agent(endpoint_url, agent_url=agent_url)
        self._client = IngestAgentClient(self._config) if self._config else None
        self._gcp = GcpHostMetricsPoller(
            ingest_provider=self._ingest_provider,
            endpoint_url=endpoint_url,
        )
        self.enabled = self._client is not None or self._gcp.enabled
        self._prefer_gcp = self._ingest_provider == "gcp_moq_relay" and self._gcp.enabled

    def poll(self) -> IngestHostMetricsSnapshot:
        if self._use_local:
            local = read_client_host_metrics()
            return IngestHostMetricsSnapshot(
                cpu_percent=local.cpu_percent,
                memory_percent=local.memory_percent,
                disk_percent=local.disk_percent,
                source="local",
            )

        if self._prefer_gcp:
            gcp = self._poll_gcp()
            if gcp.cpu_percent > 0 or gcp.memory_percent > 0 or gcp.disk_percent > 0:
                return gcp
            agent = self._poll_agent()
            if agent.source:
                return agent
            return gcp

        agent = self._poll_agent()
        if agent.cpu_percent > 0 or agent.memory_percent > 0:
            return agent
        if self._gcp.enabled:
            return self._poll_gcp()
        return agent

    def _poll_agent(self) -> IngestHostMetricsSnapshot:
        if not self._client:
            return IngestHostMetricsSnapshot()
        try:
            payload = self._client.host_metrics()
        except RuntimeError as exc:
            logger.debug("Ingest host metrics poll failed: %s", exc)
            return IngestHostMetricsSnapshot()
        return IngestHostMetricsSnapshot(
            cpu_percent=float(payload.get("cpu_percent", 0) or 0),
            memory_percent=float(payload.get("memory_percent", 0) or 0),
            disk_percent=float(payload.get("disk_percent", 0) or 0),
            source="ingest_agent",
        )

    def _poll_gcp(self) -> IngestHostMetricsSnapshot:
        gcp = self._gcp.poll()
        return IngestHostMetricsSnapshot(
            cpu_percent=gcp.cpu_percent,
            memory_percent=gcp.memory_percent,
            disk_percent=gcp.disk_percent,
            source=gcp.source or "gcp_monitoring",
        )
