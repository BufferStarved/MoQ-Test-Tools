"""Cloud provider + region metadata for ingest presets and metric time series."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass(frozen=True)
class CloudPlacement:
    cloud_provider: str = ""
    cloud_region: str = ""

    @property
    def region_label(self) -> str:
        if self.cloud_provider and self.cloud_region:
            return f"{self.cloud_provider}:{self.cloud_region}"
        if self.cloud_region:
            return self.cloud_region
        return self.cloud_provider or ""


def placement_from_ingest_provider(ingest_provider: str = "") -> CloudPlacement:
    provider = (ingest_provider or "").strip().lower()
    if not provider:
        return CloudPlacement()

    if provider.startswith("gcp_"):
        region = os.environ.get("GCP_CLOUD_REGION", "us-central1").strip() or "us-central1"
        return CloudPlacement(cloud_provider="gcp", cloud_region=region)

    if provider.startswith("linode_"):
        region = os.environ.get("LINODE_REGION", "us-east").strip() or "us-east"
        return CloudPlacement(cloud_provider="linode", cloud_region=region)

    if provider.startswith("aws_"):
        region = os.environ.get("AWS_CLOUD_REGION", "us-east-1").strip() or "us-east-1"
        return CloudPlacement(cloud_provider="aws", cloud_region=region)

    return CloudPlacement()


def merge_placement(
    *,
    cloud_provider: str = "",
    cloud_region: str = "",
    ingest_provider: str = "",
) -> CloudPlacement:
    inferred = placement_from_ingest_provider(ingest_provider)
    provider = (cloud_provider or inferred.cloud_provider).strip()
    region = (cloud_region or inferred.cloud_region).strip()
    return CloudPlacement(cloud_provider=provider, cloud_region=region)


def linode_stack_configured() -> bool:
    flag = os.environ.get("LINODE_STACK_ENABLED", "").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    has_ips = bool(linode_zixi_ip()) and bool(linode_web_ip()) and bool(linode_relay_ip())
    if flag in {"1", "true", "yes", "on"}:
        return has_ips
    return has_ips


def linode_region() -> str:
    return os.environ.get("LINODE_REGION", "us-east").strip() or "us-east"


def linode_zixi_ip() -> str:
    return os.environ.get("LINODE_ZIXI_IP", "").strip()


def linode_web_ip() -> str:
    return os.environ.get("LINODE_WEB_IP", "").strip()


def linode_relay_ip() -> str:
    return os.environ.get("LINODE_RELAY_IP", "").strip()


def linode_relay_domain(relay_ip: str = "") -> str:
    explicit = os.environ.get("LINODE_RELAY_DOMAIN", "").strip()
    if explicit:
        return explicit
    ip = (relay_ip or linode_relay_ip()).strip()
    if not ip:
        return ""
    return f"{ip.replace('.', '-')}.sslip.io"


def sslip_domain(ip: str) -> str:
    return f"{ip.replace('.', '-')}.sslip.io"


def ingest_endpoint_id_for_provider(ingest_provider: str) -> str:
    provider = (ingest_provider or "").strip().lower()
    if provider == "gcp_zixi":
        return "gcp_zixi"
    if provider == "gcp_mediamtx":
        return "gcp_mediamtx"
    if provider == "gcp_moq_relay":
        return "gcp_moq_relay"
    if provider == "linode_zixi":
        return "linode_zixi"
    if provider == "linode_mediamtx":
        return "linode_mediamtx"
    if provider == "linode_moq_relay":
        return "linode_moq_relay"
    if provider == "aws_zixi":
        return "aws_zixi"
    return ""


def resolve_placement_for_preset(
    *,
    ingest_provider: str = "",
    cloud_provider: str = "",
    cloud_region: str = "",
) -> Tuple[str, str]:
    placement = merge_placement(
        cloud_provider=cloud_provider,
        cloud_region=cloud_region,
        ingest_provider=ingest_provider,
    )
    return placement.cloud_provider, placement.cloud_region
