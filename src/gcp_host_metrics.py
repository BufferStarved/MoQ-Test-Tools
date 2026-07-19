"""GCP Cloud Monitoring host metrics for ingest/relay VMs.

Used when the ingest-agent sidecar is unavailable (notably the MoQ relay host).
Requires Monitoring Metric Viewer on the project (GCE metadata ADC on the
web/collector VM, or GOOGLE_APPLICATION_CREDENTIALS).

Environment:
  GCP_METRICS_ENABLED=1          # optional; auto-on when project is set
  GCP_METRICS_PROJECT=<project>
  GCP_METRICS_ZONE=us-central1-a
  GCP_INSTANCE_ZIXI=moq-zixi-gcp
  GCP_INSTANCE_MOQX=moq-relay-gcp
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Optional, Tuple

logger = logging.getLogger("MoQ-SRT-Bench")

METADATA_TOKEN_URL = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
)
MONITORING_API = "https://monitoring.googleapis.com/v3"


@dataclass
class GcpHostMetricsSnapshot:
    cpu_percent: float = 0.0
    memory_percent: float = 0.0
    disk_percent: float = 0.0
    source: str = ""


def gcp_metrics_enabled() -> bool:
    flag = os.environ.get("GCP_METRICS_ENABLED", "").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    if flag in {"1", "true", "yes", "on"}:
        return True
    return bool(os.environ.get("GCP_METRICS_PROJECT", "").strip()) and bool(
        os.environ.get("GCP_INSTANCE_ZIXI", "").strip()
        or os.environ.get("GCP_INSTANCE_MOQX", "").strip()
    )


def resolve_gcp_instance(ingest_provider: str = "", endpoint_url: str = "") -> Tuple[str, str]:
    """Return (instance_name, zone) for the destination host."""
    zone = os.environ.get("GCP_METRICS_ZONE", "us-central1-a").strip() or "us-central1-a"
    provider = (ingest_provider or "").strip().lower()
    endpoint = (endpoint_url or "").lower()

    if provider == "gcp_moq_relay" or "sslip.io" in endpoint or ":4433" in endpoint:
        name = os.environ.get("GCP_INSTANCE_MOQX", "moq-relay-gcp").strip()
        return name, zone

    if provider.startswith("gcp_zixi") or provider == "gcp_zixi":
        name = os.environ.get("GCP_INSTANCE_ZIXI", "moq-zixi-gcp").strip()
        return name, zone

    if provider.startswith("gcp_mediamtx") or provider == "gcp_mediamtx":
        name = os.environ.get("GCP_INSTANCE_MEDIAMTX", "moq-web-gcp").strip()
        return name, zone

    name = (
        os.environ.get("GCP_INSTANCE_ZIXI", "").strip()
        or os.environ.get("GCP_INSTANCE_MOQX", "").strip()
    )
    return name, zone


class GcpHostMetricsPoller:
    def __init__(
        self,
        *,
        ingest_provider: str = "",
        endpoint_url: str = "",
        project_id: str = "",
    ):
        self._project = (project_id or os.environ.get("GCP_METRICS_PROJECT", "")).strip()
        self._instance, self._zone = resolve_gcp_instance(ingest_provider, endpoint_url)
        self.enabled = gcp_metrics_enabled() and bool(self._project) and bool(self._instance)
        self._token = ""
        self._token_expires_at = 0.0
        self._cache: Optional[GcpHostMetricsSnapshot] = None
        self._cache_at = 0.0

    def poll(self) -> GcpHostMetricsSnapshot:
        if not self.enabled:
            return GcpHostMetricsSnapshot()

        now = time.time()
        if self._cache and now - self._cache_at < 15:
            return self._cache

        try:
            # compute.googleapis.com/instance/cpu/utilization is 0.0–1.0
            cpu = self._latest_metric("compute.googleapis.com/instance/cpu/utilization") * 100.0
            mem = self._latest_metric("agent.googleapis.com/memory/percent_used")
            disk = self._latest_metric("agent.googleapis.com/disk/percent_used")
            snapshot = GcpHostMetricsSnapshot(
                cpu_percent=round(max(0.0, cpu), 2),
                memory_percent=round(max(0.0, mem), 2),
                disk_percent=round(max(0.0, disk), 2),
                source="gcp_monitoring",
            )
            self._cache = snapshot
            self._cache_at = now
            return snapshot
        except Exception as exc:
            logger.debug("GCP host metrics poll failed: %s", exc)
            return self._cache or GcpHostMetricsSnapshot()

    def _access_token(self) -> str:
        now = time.time()
        if self._token and now < self._token_expires_at - 30:
            return self._token

        req = urllib.request.Request(
            METADATA_TOKEN_URL,
            headers={"Metadata-Flavor": "Google"},
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        self._token = str(payload.get("access_token", ""))
        expires_in = float(payload.get("expires_in", 3600) or 3600)
        self._token_expires_at = now + expires_in
        if not self._token:
            raise RuntimeError("empty GCE metadata access token")
        return self._token

    def _latest_metric(self, metric_type: str) -> float:
        end = time.time()
        start = end - 300
        filters = [
            f'metric.type="{metric_type}"',
            f'metadata.system_labels.name="{self._instance}"',
        ]
        if self._zone:
            filters.append(f'resource.labels.zone="{self._zone}"')

        params = {
            "filter": " AND ".join(filters),
            "interval.startTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start)),
            "interval.endTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(end)),
            "aggregation.alignmentPeriod": "60s",
            "aggregation.perSeriesAligner": "ALIGN_MEAN",
            "pageSize": "3",
        }
        query = urllib.parse.urlencode(params)
        url = f"{MONITORING_API}/projects/{urllib.parse.quote(self._project)}/timeSeries?{query}"
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {self._access_token()}"},
        )
        try:
            # Keep this short — sample loops call poll() every ~1s and a slow
            # Monitoring round-trip freezes CSV + preview gating.
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"monitoring API {exc.code}: {body}") from exc

        series = payload.get("timeSeries") or []
        if not series:
            return 0.0
        points = series[0].get("points") or []
        if not points:
            return 0.0
        value = points[0].get("value") or {}
        if "doubleValue" in value:
            return float(value["doubleValue"])
        if "int64Value" in value:
            return float(value["int64Value"])
        return 0.0
