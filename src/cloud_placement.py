"""Cloud provider + region metadata for ingest presets and metric time series.

Nine encode/ingest hosts (3 providers × east/central/west). Labels are the
product names shown in the picker. ``cloud_region`` is the real provider slug:

- GCP East = us-east1 · Central = us-central1 (Iowa, today's orchestrator) ·
  West = us-west1 (Oregon) — not Iowa. Old docs called Iowa "west".
- Linode East = us-east (Newark) · Central = us-central (Dallas; real slug) ·
  West = us-west (Fremont).
- AWS East = us-east-1 · Central = us-east-2 (Ohio; AWS has no us-central) ·
  West = us-west-2.

Env: ``GCP_*`` = Central, ``GCP_EAST_*`` = East, ``LINODE_*`` = East (live
today when IPs are set). Reserved prefixes for later stacks: ``GCP_WEST_*``,
``LINODE_CENTRAL_*``, ``LINODE_WEST_*``, ``AWS_EAST_*``, ``AWS_CENTRAL_*``,
``AWS_WEST_*``. Do not terraform-apply from this module.
"""

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


@dataclass(frozen=True)
class EncodeHost:
    """One physical encode/ingest stack. ``id`` is stable in the API/UI."""

    id: str
    provider: str
    region: str
    label: str
    cloud_region: str
    ingest_prefix: str
    preset_slug: str
    env_prefix: str
    region_env: str
    subtitle: str
    always_available: bool = False


# Picker order is the product grid: GCP / Linode / AWS × East / Central / West.
# ingest_prefix keeps live recipe IDs: gcp_* (central), gcp_east_*, linode_* (east).
ENCODE_HOSTS: Tuple[EncodeHost, ...] = (
    EncodeHost(
        id="gcp_east",
        provider="gcp",
        region="east",
        label="GCP East",
        cloud_region="us-east1",
        ingest_prefix="gcp_east",
        preset_slug="gcp_east",
        env_prefix="GCP_EAST",
        region_env="GCP_EAST_REGION",
        subtitle="us-east1",
    ),
    EncodeHost(
        id="gcp_central",
        provider="gcp",
        region="central",
        label="GCP Central",
        cloud_region="us-central1",
        ingest_prefix="gcp",
        preset_slug="gcp",
        env_prefix="GCP",
        region_env="GCP_CLOUD_REGION",
        subtitle="us-central1 (Iowa)",
        always_available=True,
    ),
    EncodeHost(
        id="gcp_west",
        provider="gcp",
        region="west",
        label="GCP West",
        cloud_region="us-west1",
        ingest_prefix="gcp_west",
        preset_slug="gcp_west",
        env_prefix="GCP_WEST",
        region_env="GCP_WEST_REGION",
        subtitle="us-west1 (Oregon)",
    ),
    EncodeHost(
        id="linode_east",
        provider="linode",
        region="east",
        label="Linode East",
        cloud_region="us-east",
        ingest_prefix="linode",
        preset_slug="linode",
        env_prefix="LINODE",
        region_env="LINODE_REGION",
        subtitle="us-east (Newark)",
    ),
    EncodeHost(
        id="linode_central",
        provider="linode",
        region="central",
        label="Linode Central",
        cloud_region="us-central",
        ingest_prefix="linode_central",
        preset_slug="linode_central",
        env_prefix="LINODE_CENTRAL",
        region_env="LINODE_CENTRAL_REGION",
        subtitle="us-central (Dallas)",
    ),
    EncodeHost(
        id="linode_west",
        provider="linode",
        region="west",
        label="Linode West",
        cloud_region="us-west",
        ingest_prefix="linode_west",
        preset_slug="linode_west",
        env_prefix="LINODE_WEST",
        region_env="LINODE_WEST_REGION",
        subtitle="us-west (Fremont)",
    ),
    EncodeHost(
        id="aws_east",
        provider="aws",
        region="east",
        label="AWS East",
        cloud_region="us-east-1",
        ingest_prefix="aws_east",
        preset_slug="aws_east",
        env_prefix="AWS_EAST",
        region_env="AWS_EAST_REGION",
        subtitle="us-east-1",
    ),
    EncodeHost(
        id="aws_central",
        provider="aws",
        region="central",
        label="AWS Central",
        cloud_region="us-east-2",
        ingest_prefix="aws_central",
        preset_slug="aws_central",
        env_prefix="AWS_CENTRAL",
        region_env="AWS_CENTRAL_REGION",
        subtitle="us-east-2 (Ohio)",
    ),
    EncodeHost(
        id="aws_west",
        provider="aws",
        region="west",
        label="AWS West",
        cloud_region="us-west-2",
        ingest_prefix="aws_west",
        preset_slug="aws_west",
        env_prefix="AWS_WEST",
        region_env="AWS_WEST_REGION",
        subtitle="us-west-2",
    ),
)

_HOST_BY_ID = {host.id: host for host in ENCODE_HOSTS}
_HOSTS_LONGEST_PREFIX = tuple(
    sorted(ENCODE_HOSTS, key=lambda host: len(host.ingest_prefix), reverse=True)
)
INGEST_ROLES = ("zixi", "mediamtx", "moq_relay", "moq_relay_d18")


def host_by_id(host_id: str) -> Optional[EncodeHost]:
    return _HOST_BY_ID.get((host_id or "").strip())


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


def host_env(host: EncodeHost, suffix: str, default: str = "") -> str:
    return os.environ.get(f"{host.env_prefix}_{suffix}", default).strip()


def host_region(host: EncodeHost) -> str:
    return os.environ.get(host.region_env, host.cloud_region).strip() or host.cloud_region


def host_zixi_ip(host: EncodeHost) -> str:
    return host_env(host, "ZIXI_IP")


def host_web_ip(host: EncodeHost) -> str:
    return host_env(host, "WEB_IP")


def host_relay_ip(host: EncodeHost) -> str:
    return host_env(host, "RELAY_IP")


def host_relay_domain(host: EncodeHost, relay_ip: str = "") -> str:
    explicit = host_env(host, "RELAY_DOMAIN")
    if explicit:
        return explicit
    ip = (relay_ip or host_relay_ip(host)).strip()
    if not ip:
        return ""
    return sslip_domain(ip)


def host_role_configured(host: EncodeHost, role: str) -> bool:
    """Zixi / MediaMTX / MoQ can come up independently on one region."""
    if host.always_available:
        return True
    flag = _env_flag_enabled(f"{host.env_prefix}_STACK_ENABLED")
    if flag is False:
        return False
    if role == "zixi":
        return bool(host_zixi_ip(host))
    if role == "mediamtx":
        return bool(host_web_ip(host))
    if role in {"moq_relay", "moq_relay_d18"}:
        return bool(host_relay_ip(host))
    return False


def host_stack_configured(host: EncodeHost) -> bool:
    """True when any ingest software on this host is wired."""
    if host.always_available:
        return True
    return any(
        host_role_configured(host, role) for role in ("zixi", "mediamtx", "moq_relay_d18")
    )


def host_from_ingest_provider(ingest_provider: str = "") -> Optional[EncodeHost]:
    provider = (ingest_provider or "").strip().lower()
    if not provider:
        return None
    for host in _HOSTS_LONGEST_PREFIX:
        prefix = host.ingest_prefix
        if provider == prefix or provider.startswith(f"{prefix}_"):
            return host
    # Legacy single-AWS stub (aws_zixi) before aws_east_ existed.
    if provider.startswith("aws_"):
        return _HOST_BY_ID["aws_east"]
    return None


def placement_from_ingest_provider(ingest_provider: str = "") -> CloudPlacement:
    provider = (ingest_provider or "").strip().lower()
    if not provider:
        return CloudPlacement()
    host = host_from_ingest_provider(provider)
    if host is None:
        return CloudPlacement()
    return CloudPlacement(cloud_provider=host.provider, cloud_region=host_region(host))


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
    return host_stack_configured(_HOST_BY_ID["linode_east"])


def gcp_east_stack_configured() -> bool:
    return host_stack_configured(_HOST_BY_ID["gcp_east"])


def gcp_east_region() -> str:
    return host_region(_HOST_BY_ID["gcp_east"])


def gcp_east_zixi_ip() -> str:
    return host_zixi_ip(_HOST_BY_ID["gcp_east"])


def gcp_east_web_ip() -> str:
    return host_web_ip(_HOST_BY_ID["gcp_east"])


def gcp_east_relay_ip() -> str:
    return host_relay_ip(_HOST_BY_ID["gcp_east"])


def gcp_east_relay_domain(relay_ip: str = "") -> str:
    return host_relay_domain(_HOST_BY_ID["gcp_east"], relay_ip)


def linode_region() -> str:
    return host_region(_HOST_BY_ID["linode_east"])


def linode_zixi_ip() -> str:
    return host_zixi_ip(_HOST_BY_ID["linode_east"])


def linode_web_ip() -> str:
    return host_web_ip(_HOST_BY_ID["linode_east"])


def linode_relay_ip() -> str:
    return host_relay_ip(_HOST_BY_ID["linode_east"])


def linode_relay_domain(relay_ip: str = "") -> str:
    return host_relay_domain(_HOST_BY_ID["linode_east"], relay_ip)


def sslip_domain(ip: str) -> str:
    return f"{ip.replace('.', '-')}.sslip.io"


def ingest_endpoint_id_for_provider(ingest_provider: str) -> str:
    provider = (ingest_provider or "").strip().lower()
    host = host_from_ingest_provider(provider)
    if host is None:
        return ""
    for role in INGEST_ROLES:
        if provider == f"{host.ingest_prefix}_{role}":
            return provider
    if provider == "aws_zixi":
        return "aws_east_zixi"
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
    """UI picker: all 9 hosts. Undeployed stay visible with available=false."""
    rows: list[dict] = []
    for host in ENCODE_HOSTS:
        roles = {
            # gcp_central is always_available, but the public Zixi dest
            # (35.222.33.58) is down — do not advertise a Start-able role.
            "zixi": False if host.id == "gcp_central" else host_role_configured(host, "zixi"),
            "mediamtx": host_role_configured(host, "mediamtx"),
            "moq": host_role_configured(host, "moq_relay_d18"),
        }
        available = any(roles.values())
        missing = [name for name, ok in roles.items() if not ok]
        zixi_down = host.id == "gcp_central" and not roles["zixi"]
        rows.append(
            {
                "id": host.id,
                "label": host.label,
                "available": available,
                "roles": roles,
                "cloud_provider": host.provider,
                "cloud_region": host_region(host),
                "provider": host.provider,
                "region": host.region,
                "subtitle": host.subtitle,
                "unavailable_reason": (
                    "Zixi dest 35.222.33.58 is down"
                    if zixi_down and missing == ["zixi"]
                    else (
                        ""
                        if not missing
                        else (
                            "Not deployed"
                            if not available
                            else f"Not deployed: {', '.join(missing)}"
                        )
                    )
                ),
            }
        )
    return rows
