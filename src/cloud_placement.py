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


def _env_flag_enabled(name: str) -> Optional[bool]:
    flag = os.environ.get(name, "").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return False
    if flag in {"1", "true", "yes", "on"}:
        return True
    return None


def _stack_configured(flag_name: str, *ip_getters) -> bool:
    flag = _env_flag_enabled(flag_name)
    has_ips = all(bool(getter()) for getter in ip_getters)
    if flag is False:
        return False
    if flag is True:
        return has_ips
    return has_ips


def placement_from_ingest_provider(ingest_provider: str = "") -> CloudPlacement:
    provider = (ingest_provider or "").strip().lower()
    if not provider:
        return CloudPlacement()

    # gcp_east_* must win over gcp_* (prefix overlap).
    if provider.startswith("gcp_east_"):
        return CloudPlacement(cloud_provider="gcp", cloud_region=gcp_east_region())

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
    return _stack_configured("LINODE_STACK_ENABLED", linode_zixi_ip, linode_web_ip, linode_relay_ip)


def gcp_east_stack_configured() -> bool:
    return _stack_configured(
        "GCP_EAST_STACK_ENABLED", gcp_east_zixi_ip, gcp_east_web_ip, gcp_east_relay_ip
    )


def gcp_east_region() -> str:
    return os.environ.get("GCP_EAST_REGION", "us-east1").strip() or "us-east1"


def gcp_east_zixi_ip() -> str:
    return os.environ.get("GCP_EAST_ZIXI_IP", "").strip()


def gcp_east_web_ip() -> str:
    return os.environ.get("GCP_EAST_WEB_IP", "").strip()


def gcp_east_relay_ip() -> str:
    return os.environ.get("GCP_EAST_RELAY_IP", "").strip()


def gcp_east_relay_domain(relay_ip: str = "") -> str:
    explicit = os.environ.get("GCP_EAST_RELAY_DOMAIN", "").strip()
    if explicit:
        return explicit
    ip = (relay_ip or gcp_east_relay_ip()).strip()
    if not ip:
        return ""
    return sslip_domain(ip)


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
    if provider == "gcp_moq_relay_d18":
        return "gcp_moq_relay_d18"
    if provider == "gcp_east_zixi":
        return "gcp_east_zixi"
    if provider == "gcp_east_mediamtx":
        return "gcp_east_mediamtx"
    if provider == "gcp_east_moq_relay":
        return "gcp_east_moq_relay"
    if provider == "gcp_east_moq_relay_d18":
        return "gcp_east_moq_relay_d18"
    if provider == "linode_zixi":
        return "linode_zixi"
    if provider == "linode_mediamtx":
        return "linode_mediamtx"
    if provider == "linode_moq_relay":
        return "linode_moq_relay"
    if provider == "linode_moq_relay_d18":
        return "linode_moq_relay_d18"
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


def encode_hosts_for_api() -> list[dict]:
    """UI picker: which clouds can host ingest (and later, encode)."""
    return [
        {
            "id": "gcp",
            "label": "GCP us-central1",
            "available": True,
            "cloud_provider": "gcp",
            "cloud_region": os.environ.get("GCP_CLOUD_REGION", "us-central1").strip() or "us-central1",
        },
        {
            "id": "gcp_east",
            "label": f"GCP {gcp_east_region()}",
            "available": gcp_east_stack_configured(),
            "cloud_provider": "gcp",
            "cloud_region": gcp_east_region(),
        },
        {
            "id": "linode",
            "label": f"Linode {linode_region()}",
            "available": linode_stack_configured(),
            "cloud_provider": "linode",
            "cloud_region": linode_region(),
        },
        {
            "id": "aws",
            "label": "AWS",
            "available": False,
            "cloud_provider": "aws",
            "cloud_region": os.environ.get("AWS_CLOUD_REGION", "us-east-1").strip() or "us-east-1",
        },
    ]
