import logging
from dataclasses import dataclass

from ingest_agent_client import IngestAgentClient, resolve_ingest_agent

logger = logging.getLogger("MoQ-SRT-Bench")


@dataclass
class IngestHostMetricsSnapshot:
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    disk_percent: float = 0.0


class IngestHostMetricsPoller:
    def __init__(self, endpoint_url: str, *, agent_url: str = ""):
        self._config = resolve_ingest_agent(endpoint_url, agent_url=agent_url)
        self._client = IngestAgentClient(self._config) if self._config else None
        self.enabled = self._client is not None

    def poll(self) -> IngestHostMetricsSnapshot:
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
        )
