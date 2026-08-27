import os
import sys
from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

from cloud_placement import (
    ENCODE_HOSTS,
    EncodeHost,
    host_relay_domain,
    host_relay_ip,
    host_region,
    host_role_configured,
    host_web_ip,
    host_zixi_ip,
    merge_placement,
    placement_from_ingest_provider,
)
from moq_publish import MoqPublishTarget, parse_moq_publish_url

CENTRAL_WEB_INGEST_AGENT = "http://34.9.217.178:8090"
# MoQ recorder lives on the web ingest agent. Do not fall back to the Zixi
# worker URL even though that host is up again — its recorder path is optional.
ZIXI_CENTRAL_AGENT = "http://35.222.33.58:8090"
ZIXI_GCP_ENCODE_HOST = "35.222.33.58"
ZIXI_GCP_ENCODE_UNAVAILABLE_REASON = ""


def _usable_recorder_url(url: str) -> str:
    cleaned = (url or "").strip().rstrip("/")
    if not cleaned or ZIXI_CENTRAL_AGENT.split("://", 1)[-1].split(":")[0] in cleaned:
        return ""
    return cleaned


def moq_recorder_agent_url(regional_fallback: str = "") -> str:
    """MoQ VMAF recordings subscribe over WebTransport on an ingest agent.

    Prefer an explicit MOQ_RECORDER_AGENT_URL (never the Zixi worker). Else
    the central GCP web recorder — that host's docker/quiche handshakes to
    public :14433 Let's Encrypt (west and Dallas proven 2026-08-26). Regional
    Linode recorders fail the same URL with ``Opening handshake failed``
    (stale baked cert.mjs and/or public-IP hairpin). ``regional_fallback`` is
    last-resort only.
    """
    explicit = _usable_recorder_url(os.environ.get("MOQ_RECORDER_AGENT_URL", ""))
    if explicit:
        return explicit
    central = _usable_recorder_url(CENTRAL_WEB_INGEST_AGENT)
    if central:
        return central
    return _usable_recorder_url(
        regional_fallback or os.environ.get("INGEST_AGENT_URL", "")
    )


class DestinationConfigError(Exception):
    """Raised when a destination URL or preset cannot be resolved."""


SUPPORTED_PROTOCOLS = ("srt", "rtmp", "hls", "dash", "webrtc", "moq")
# HLS/DASH here mean Zixi TS-over-HTTP PUT ingest. That Broadcaster input
# stops draining after ~2s — never offer it as a Start-able web recipe.
WEB_RETIRED_PROTOCOLS = frozenset({"hls", "dash"})
WEB_OFFERED_PROTOCOLS = tuple(
    protocol for protocol in SUPPORTED_PROTOCOLS if protocol not in WEB_RETIRED_PROTOCOLS
)

HTTP_TS_PUT_UNAVAILABLE_REASON = (
    "Zixi HTTP-TS PUT ingest stops draining after about 2 seconds on current "
    "Broadcaster settings (reproduced with bare ffmpeg). This recipe is retired "
    "— use SRT or RTMP ingest to Zixi for Fast HLS / HTTP-TS playback. Do not "
    "run configure-zixi-hls-dash-output.sh; it restarts Broadcaster and can drop "
    "live SRT inputs."
)

SYNTAX_BY_PROTOCOL = {
    "srt": "srt://<host>:<port>?mode=caller&latency=<microseconds>[&streamid=<id>]",
    "rtmp": "rtmp://<host>[:<port>]/<application>/<stream-key>",
    "hls": "http(s)://<host>:<port>/<stream-id> (TS over HTTP push ingest; Zixi serves HLS output)",
    "dash": "http(s)://<host>:<port>/<stream-id> (TS over HTTP push ingest; Zixi serves DASH output)",
    "webrtc": "https://<host>/<whip-path> or whip://<host>/<path>",
    "moq": "https://<relay-host>:14433/moq-relay?namespace=benchmark&draft=18 (moqx draft-18 via moq5-fmp4-publish)",
}

PROTOCOL_LABELS = {
    "srt": "SRT",
    "rtmp": "RTMP",
    "hls": "HLS",
    "dash": "DASH",
    "webrtc": "WebRTC (WHIP)",
    "moq": "MoQ",
}


@dataclass(frozen=True)
class ServicePreset:
    id: str
    name: str
    protocol: str
    url: str = ""
    url_template: str = ""
    env_vars: Tuple[str, ...] = ()
    notes: str = ""
    supports_vmaf: bool = False
    ingest_agent_url: str = ""
    ingest_recording_dir: str = ""
    ingest_provider: str = ""
    cloud_provider: str = ""
    cloud_region: str = ""
    web_visible: bool = True
    web_available: bool = True


@dataclass
class DestinationProfile:
    protocol: str
    url: str
    label: str = ""
    preset_id: str = ""
    ingest_provider: str = ""
    cloud_provider: str = ""
    cloud_region: str = ""
    moq_target: Optional[MoqPublishTarget] = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.protocol == "moq" and self.moq_target is None:
            self.moq_target = parse_moq_publish_url(self.url)

    def ffmpeg_output_args(self) -> List[str]:
        if self.protocol == "srt":
            return ["-f", "mpegts", self.url]
        if self.protocol == "rtmp":
            return [
                "-f",
                "flv",
                "-flvflags",
                "no_duration_filesize",
                self.url,
            ]
        if self.protocol in {"hls", "dash"}:
            return [
                # Zixi's TS-over-HTTP push input has been observed to stop
                # draining the PUT socket after the first ~2s of a continuous
                # live feed (reproduced independently of this service — raw
                # ffmpeg freezes identically). Without rw_timeout the write()
                # blocks forever and the job silently "succeeds" with frozen
                # progress instead of failing. -1 -> fail fast with a clear
                # error rather than reporting fake healthy-looking metrics.
                "-rw_timeout",
                "8000000",
                "-f",
                "mpegts",
                "-method",
                "PUT",
                self.url,
            ]
        if self.protocol == "http":
            return [
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov",
                "-method", "PUT",
                self.url,
            ]
        if self.protocol == "webrtc":
            return ["-f", "whip", self.url]
        if self.protocol == "moq":
            return [
                "-f",
                "mp4",
                "-movflags",
                "+frag_keyframe+empty_moov+default_base_moof+separate_moof",
                "pipe:1",
            ]
        raise DestinationConfigError(f"Unsupported protocol: {self.protocol}")


_SERVICE_PRESETS_RAW: List[ServicePreset] = [
    ServicePreset(
        id="moq_zixi_gcp",
        name="Zixi Broadcaster gcp-us-central1",
        protocol="srt",
        url="srt://35.222.33.58:10080?mode=caller&latency=200000",
        notes=(
            "Managed Zixi SRT ingest on GCP. Zixi input stream ID is 'SRT Test'; "
            "upload adds streamid=#!::r=SRT Test,m=publish automatically. "
            "Browser playback uses error-concealed 'SRT Test EC' "
            "(primary Fast HLS packager wedges after first connect). "
            "HLS: playback.m3u8?stream=SRT%20Test%20EC. "
            "HTTP-TS: http://35.222.33.58:7777/SRT%20Test%20EC.ts. "
            "Publishes apply monotonic -output_ts_offset. "
            "Upload transcodes to H.264 Main yuv420p for browser playback."
        ),
        supports_vmaf=True,
        ingest_agent_url="http://35.222.33.58:8090",
        ingest_recording_dir="/opt/zixi_broadcaster-linux64",
        ingest_provider="gcp_zixi",
    ),
    ServicePreset(
        id="moq_zixi_gcp_rtmp",
        name="Zixi Broadcaster gcp-us-central1",
        protocol="rtmp",
        url="rtmp://35.222.33.58:1935/live/benchmark",
        notes=(
            "Managed Zixi RTMP ingest on GCP. Stream ID must be benchmark "
            "(rtmp://host:1935/live/benchmark). "
            "Default browser preview is HTTP-TS (mpegts.js) at "
            "http://host:7777/benchmark.ts — bypasses Fast HLS for faster join. "
            "HLS playback.m3u8?stream=benchmark remains available. "
            "Offline .ts returns empty HTTP 200."
        ),
        supports_vmaf=True,
        ingest_agent_url="http://35.222.33.58:8090",
        ingest_recording_dir="/opt/zixi_broadcaster-linux64",
        ingest_provider="gcp_zixi",
    ),
    ServicePreset(
        id="moq_zixi_gcp_hls",
        name="Zixi Broadcaster gcp-us-central1",
        protocol="hls",
        url="http://35.222.33.58:7777/benchmark",
        notes=HTTP_TS_PUT_UNAVAILABLE_REASON,
        supports_vmaf=True,
        ingest_agent_url="http://35.222.33.58:8090",
        ingest_recording_dir="/opt/zixi_broadcaster-linux64",
        ingest_provider="gcp_zixi",
        web_visible=False,
        web_available=False,
    ),
    ServicePreset(
        id="moq_zixi_gcp_dash",
        name="Zixi Broadcaster gcp-us-central1",
        protocol="dash",
        url="http://35.222.33.58:7777/benchmark",
        notes=HTTP_TS_PUT_UNAVAILABLE_REASON,
        supports_vmaf=True,
        ingest_agent_url="http://35.222.33.58:8090",
        ingest_recording_dir="/opt/zixi_broadcaster-linux64",
        ingest_provider="gcp_zixi",
        web_visible=False,
        web_available=False,
    ),
    ServicePreset(
        id="moq_gcp_relay",
        name="OpenMOQ MOQ-X draft-16 gcp-us-central1",
        protocol="moq",
        url="https://34-28-164-90.sslip.io:4433/moq-relay?namespace=benchmark",
        notes=(
            "Legacy UDP 4433 (ghcr.io/openmoq/moqx:329b98b). Hidden from the UI. "
            "Public MoQ is moq_gcp_relay_d18 on :14433. "
            "Ingest VMAF: ./scripts/install-openmoq-recorder.sh"
        ),
        web_visible=False,
        supports_vmaf=True,
        ingest_agent_url=moq_recorder_agent_url(CENTRAL_WEB_INGEST_AGENT),
        ingest_recording_dir="/var/lib/moq-relay-recordings",
        ingest_provider="gcp_moq_relay",
    ),
    ServicePreset(
        id="moq_gcp_relay_d18",
        name="OpenMOQ MOQ-X draft-18 gcp-us-central1",
        protocol="moq",
        url="https://34-28-164-90.sslip.io:14433/moq-relay?namespace=benchmark&draft=18",
        notes=(
            "Public MoQ path. moqx on UDP 14433 (scripts/canary-moqx.sh). Speaks moqt-18. "
            "ffmpeg → moq5-fmp4-publish. :4433 remains running as unused draft-16."
        ),
        supports_vmaf=True,
        ingest_agent_url=moq_recorder_agent_url(CENTRAL_WEB_INGEST_AGENT),
        ingest_recording_dir="/var/lib/moq-relay-recordings",
        ingest_provider="gcp_moq_relay_d18",
    ),
    ServicePreset(
        id="moq_mediamtx_gcp_srt",
        name="MediaMTX gcp-us-central1 (LL delivery)",
        protocol="srt",
        # streamid already set — do not overlay Zixi #!::r=… payload.
        url="srt://34.9.217.178:8890?mode=caller&latency=200000&streamid=publish:benchmark",
        notes=(
            "MediaMTX SRT publish → LL-HLS / WHEP playback. "
            "HLS: http://34.9.217.178:8888/benchmark/index.m3u8 · "
            "WHEP: http://34.9.217.178:8889/benchmark/whep. "
            "Install: infra/mediamtx/scripts/install-mediamtx.sh"
        ),
        supports_vmaf=False,
        ingest_provider="gcp_mediamtx",
    ),
    ServicePreset(
        id="moq_mediamtx_gcp_rtmp",
        name="MediaMTX gcp-us-central1 (LL delivery)",
        protocol="rtmp",
        url="rtmp://34.9.217.178:1935/benchmark",
        notes=(
            "MediaMTX RTMP publish → LL-HLS / WHEP playback. "
            "Install: infra/mediamtx/scripts/install-mediamtx.sh"
        ),
        supports_vmaf=False,
        ingest_provider="gcp_mediamtx",
    ),
    ServicePreset(
        id="moq_mediamtx_gcp_whip",
        name="MediaMTX gcp-us-central1 (LL delivery)",
        protocol="webrtc",
        url="http://34.9.217.178:8889/benchmark/whip",
        notes=(
            "ffmpeg WHIP publish into MediaMTX (Opus audio required by the WHIP muxer); "
            "play with WHEP or LL-HLS. Co-located publish uses 127.0.0.1 to avoid GCP "
            "hairpin. Install: infra/mediamtx/scripts/install-mediamtx.sh"
        ),
        supports_vmaf=False,
        ingest_provider="gcp_mediamtx",
    ),
    ServicePreset(
        id="local_srs_srt",
        name="Local SRS SRT listener",
        protocol="srt",
        url="srt://127.0.0.1:10080?mode=caller&latency=200000",
        notes="Run: docker run -p 10080:10080 ossrs/srs:5",
        web_visible=False,
    ),
    ServicePreset(
        id="nanocosmos_srt_global",
        name="nanoStream Cloud SRT (global)",
        protocol="srt",
        url_template=(
            "srt://bintu-srt.nanocosmos.de:5000"
            "?mode=caller&latency=500000&timeout=1000000&transtype=live"
            "&streamid=push:{nano_srt_stream_id}"
        ),
        env_vars=("NANO_SRT_STREAM_ID",),
        notes="Set NANO_SRT_STREAM_ID to your Bintu stream ID.",
        web_visible=False,
    ),
    ServicePreset(
        id="gcore_srt",
        name="Gcore SRT ingest",
        protocol="srt",
        url_template="{gcore_srt_push_url}",
        env_vars=("GCORE_SRT_PUSH_URL",),
        notes="Set GCORE_SRT_PUSH_URL to the full srt:// URL from Gcore.",
        web_visible=False,
    ),
    ServicePreset(
        id="local_rtmp",
        name="Local RTMP server",
        protocol="rtmp",
        url="rtmp://127.0.0.1:1935/live/benchmark",
        notes="Requires a local RTMP listener on port 1935.",
        web_visible=False,
    ),
    ServicePreset(
        id="antmedia_rtmp",
        name="Ant Media Server RTMP",
        protocol="rtmp",
        url_template="{ant_media_rtmp_url}",
        env_vars=("ANT_MEDIA_RTMP_URL",),
        notes="Example: rtmp://your-server/LiveApp/streamId",
        web_visible=False,
    ),
    ServicePreset(
        id="minio_put",
        name="Local MinIO presigned PUT",
        protocol="http",
        url_template="{minio_put_url}",
        env_vars=("MINIO_PUT_URL",),
        notes="Set MINIO_PUT_URL to a presigned PUT URL.",
        web_visible=False,
    ),
    ServicePreset(
        id="s3_presigned_put",
        name="AWS S3 presigned PUT",
        protocol="http",
        url_template="{s3_presigned_put_url}",
        env_vars=("S3_PRESIGNED_PUT_URL",),
        web_visible=False,
    ),
    ServicePreset(
        id="r2_presigned_put",
        name="Cloudflare R2 presigned PUT",
        protocol="http",
        url_template="{r2_presigned_put_url}",
        env_vars=("R2_PRESIGNED_PUT_URL",),
        web_visible=False,
    ),
    ServicePreset(
        id="local_whip",
        name="Local WHIP endpoint",
        protocol="webrtc",
        url="http://127.0.0.1:8080/whip/endpoint",
        notes="Requires a local WHIP-capable server.",
        web_visible=False,
    ),
    ServicePreset(
        id="whip_env",
        name="WHIP endpoint from WHIP_URL",
        protocol="webrtc",
        url_template="{whip_url}",
        env_vars=("WHIP_URL",),
        web_visible=False,
    ),
]

# GCP Central presets stay hardcoded above (live IPs). Every other host is
# generated so a 4th stack is env+IPs, not another copy-pasted builder.
_HARDCODED_HOST_IDS = frozenset({"gcp_central"})


def _tag_cloud_presets(presets: List[ServicePreset]) -> List[ServicePreset]:
    tagged: List[ServicePreset] = []
    for preset in presets:
        if preset.cloud_provider or preset.cloud_region:
            tagged.append(preset)
            continue
        placement = placement_from_ingest_provider(preset.ingest_provider)
        if not placement.cloud_provider:
            tagged.append(preset)
            continue
        tagged.append(
            replace(
                preset,
                cloud_provider=placement.cloud_provider,
                cloud_region=placement.cloud_region,
            )
        )
    return tagged


def _build_stack_presets(host: EncodeHost) -> List[ServicePreset]:
    """Zixi + MediaMTX + MoQ :14433 for one host. Undeployed stacks stay visible."""
    slug = host.preset_slug
    prefix = host.ingest_prefix
    region = host_region(host)
    zixi_ok = host_role_configured(host, "zixi")
    mtx_ok = host_role_configured(host, "mediamtx")
    moq_ok = host_role_configured(host, "moq_relay_d18")
    zixi_ip = host_zixi_ip(host)
    web_ip = host_web_ip(host)
    relay_ip = host_relay_ip(host)
    relay_domain = host_relay_domain(host, relay_ip)
    zixi_agent = f"http://{zixi_ip}:8090" if zixi_ip else ""
    web_agent = f"http://{web_ip}:8090" if web_ip else ""
    placement = dict(
        cloud_provider=host.provider,
        cloud_region=region,
    )
    live = dict(
        **placement,
        web_visible=True,
        web_available=True,
    )
    stub = dict(
        **placement,
        web_visible=True,
        web_available=False,
    )
    zixi_vis = live if zixi_ok else stub
    mtx_vis = live if mtx_ok else stub
    moq_vis = live if moq_ok else stub

    relay_d16 = f"https://{relay_domain}:4433/moq-relay?namespace=benchmark" if relay_domain else ""
    # Public MoQ is :14433 (draft=18). Leftover :4433 stays off the picker.
    relay_d18 = (
        f"https://{relay_domain}:14433/moq-relay?namespace=benchmark&draft=18"
        if relay_domain
        else ""
    )
    return [
        ServicePreset(
            id=f"moq_zixi_{slug}",
            name=f"Zixi · {host.label}",
            protocol="srt",
            url=f"srt://{zixi_ip}:10080?mode=caller&latency=200000" if zixi_ok else "",
            notes=(
                f"Managed Zixi SRT ingest on {host.label} ({region}). Stream ID 'SRT Test'; "
                f"HLS: http://{zixi_ip}:7777/playback.m3u8?stream=SRT%20Test%20EC."
                if zixi_ok
                else "Not deployed"
            ),
            supports_vmaf=True,
            ingest_agent_url=zixi_agent,
            ingest_recording_dir="/opt/zixi_broadcaster-linux64",
            ingest_provider=f"{prefix}_zixi",
            **zixi_vis,
        ),
        ServicePreset(
            id=f"moq_zixi_{slug}_rtmp",
            name=f"Zixi · {host.label}",
            protocol="rtmp",
            url=f"rtmp://{zixi_ip}:1935/live/benchmark" if zixi_ok else "",
            notes=f"Managed Zixi RTMP ingest on {host.label} ({region})." if zixi_ok else "Not deployed",
            supports_vmaf=True,
            ingest_agent_url=zixi_agent,
            ingest_recording_dir="/opt/zixi_broadcaster-linux64",
            ingest_provider=f"{prefix}_zixi",
            **zixi_vis,
        ),
        ServicePreset(
            id=f"moq_zixi_{slug}_hls",
            name=f"Zixi · {host.label}",
            protocol="hls",
            url=f"http://{zixi_ip}:7777/benchmark",
            notes=HTTP_TS_PUT_UNAVAILABLE_REASON,
            supports_vmaf=True,
            ingest_agent_url=zixi_agent,
            ingest_recording_dir="/opt/zixi_broadcaster-linux64",
            ingest_provider=f"{prefix}_zixi",
            **{**placement, "web_visible": False, "web_available": False},
        ),
        ServicePreset(
            id=f"moq_zixi_{slug}_dash",
            name=f"Zixi · {host.label}",
            protocol="dash",
            url=f"http://{zixi_ip}:7777/benchmark",
            notes=HTTP_TS_PUT_UNAVAILABLE_REASON,
            supports_vmaf=True,
            ingest_agent_url=zixi_agent,
            ingest_recording_dir="/opt/zixi_broadcaster-linux64",
            ingest_provider=f"{prefix}_zixi",
            **{**placement, "web_visible": False, "web_available": False},
        ),
        ServicePreset(
            id=f"moq_{slug}_relay",
            name=f"OpenMOQ draft-16 · {host.label}",
            protocol="moq",
            url=relay_d16,
            notes=(
                f"Legacy :4433 draft-16 on {host.label}. Hidden. Public MoQ is :14433."
            ),
            supports_vmaf=True,
            ingest_agent_url=moq_recorder_agent_url(web_agent),
            ingest_recording_dir="/var/lib/moq-relay-recordings",
            ingest_provider=f"{prefix}_moq_relay",
            **{**live, "web_visible": False},
        ),
        ServicePreset(
            id=f"moq_{slug}_relay_d18",
            name=f"OpenMOQ · {host.label}",
            protocol="moq",
            url=relay_d18 if moq_ok else "",
            notes=(
                f"Public MoQ path on {host.label}. moqx on UDP 14433. Speaks moqt-18. "
                "ffmpeg → moq5-fmp4-publish."
                if moq_ok
                else "Not deployed. Public MoQ is WebTransport :14433 (draft=18), not leftover :4433."
            ),
            supports_vmaf=True,
            ingest_agent_url=moq_recorder_agent_url(web_agent),
            ingest_recording_dir="/var/lib/moq-relay-recordings",
            ingest_provider=f"{prefix}_moq_relay_d18",
            **moq_vis,
        ),
        ServicePreset(
            id=f"moq_mediamtx_{slug}_srt",
            name=f"MediaMTX · {host.label}",
            protocol="srt",
            url=(
                f"srt://{web_ip}:8890?mode=caller&latency=200000&streamid=publish:benchmark"
                if mtx_ok
                else ""
            ),
            notes=(
                f"MediaMTX SRT on {host.label}. HLS: http://{web_ip}:8888/benchmark/index.m3u8."
                if mtx_ok
                else "Not deployed"
            ),
            supports_vmaf=False,
            ingest_agent_url=web_agent,
            ingest_provider=f"{prefix}_mediamtx",
            **mtx_vis,
        ),
        ServicePreset(
            id=f"moq_mediamtx_{slug}_rtmp",
            name=f"MediaMTX · {host.label}",
            protocol="rtmp",
            url=f"rtmp://{web_ip}:1935/benchmark" if mtx_ok else "",
            notes=f"MediaMTX RTMP on {host.label}." if mtx_ok else "Not deployed",
            supports_vmaf=False,
            ingest_agent_url=web_agent,
            ingest_provider=f"{prefix}_mediamtx",
            **mtx_vis,
        ),
        ServicePreset(
            id=f"moq_mediamtx_{slug}_whip",
            name=f"MediaMTX · {host.label}",
            protocol="webrtc",
            url=f"http://{web_ip}:8889/benchmark/whip" if mtx_ok else "",
            notes=(
                f"ffmpeg WHIP publish into {host.label} MediaMTX (Opus audio required)."
                if mtx_ok
                else "Not deployed"
            ),
            supports_vmaf=False,
            ingest_agent_url=web_agent,
            ingest_provider=f"{prefix}_mediamtx",
            **mtx_vis,
        ),
    ]


def _finalize_service_presets(raw: List[ServicePreset]) -> List[ServicePreset]:
    tagged = _tag_cloud_presets(raw)
    extras: List[ServicePreset] = []
    for host in ENCODE_HOSTS:
        if host.id in _HARDCODED_HOST_IDS:
            continue
        extras.extend(_build_stack_presets(host))
    return tagged + extras


SERVICE_PRESETS: List[ServicePreset] = _finalize_service_presets(_SERVICE_PRESETS_RAW)

PRESET_BY_ID: Dict[str, ServicePreset] = {preset.id: preset for preset in SERVICE_PRESETS}


def zixi_gcp_encode_blocked(
    preset_id: Optional[str] = None,
    url: str = "",
) -> Optional[str]:
    """Start gate for the public Zixi VM. Box is up again (2026-08-26)."""
    del preset_id, url
    return None


def http_ts_put_preset_blocked(preset_id: Optional[str]) -> Optional[str]:
    """Fail-closed Start gate for retired Zixi HTTP-TS PUT recipes."""
    preset = PRESET_BY_ID.get((preset_id or "").strip())
    if preset is None:
        return None
    if preset.protocol not in WEB_RETIRED_PROTOCOLS:
        return None
    provider = (preset.ingest_provider or "").lower()
    if "zixi" not in provider:
        return None
    if preset.web_available:
        return None
    if "coming soon" in (preset.notes or "").lower():
        return (
            f"Ingest endpoint '{preset.name}' is not configured yet for "
            f"{preset.protocol.upper()}."
        )
    return HTTP_TS_PUT_UNAVAILABLE_REASON


def recording_dir_for_preset(preset_id: str) -> str:
    preset = PRESET_BY_ID.get(preset_id)
    if preset is not None and preset.ingest_recording_dir:
        return preset.ingest_recording_dir
    return os.environ.get("INGEST_RECORDING_DIR", "/opt/zixi_broadcaster-linux64")


def ingest_agent_url_for_preset(preset_id: str) -> str:
    preset = PRESET_BY_ID.get(preset_id)
    if preset is not None and preset.ingest_agent_url:
        return preset.ingest_agent_url
    # MediaMTX is co-located on moq-web — never inherit the Zixi agent URL.
    if preset is not None and (preset.ingest_provider or "").strip().lower().endswith("_mediamtx"):
        return ""
    return os.environ.get("INGEST_AGENT_BASE_URL", "").strip()


def ingest_settings_for_preset(preset_id: str) -> tuple[str, str]:
    return (
        ingest_agent_url_for_preset(preset_id),
        recording_dir_for_preset(preset_id),
    )


def list_presets_text() -> str:
    lines = ["Available endpoint presets:", ""]
    for protocol in SUPPORTED_PROTOCOLS:
        presets = [preset for preset in SERVICE_PRESETS if preset.protocol == protocol]
        if not presets:
            continue
        lines.append(f"[{PROTOCOL_LABELS[protocol]}]")
        for preset in presets:
            env_note = f" (env: {', '.join(preset.env_vars)})" if preset.env_vars else ""
            lines.append(f"  {preset.id}: {preset.name}{env_note}")
            if preset.notes:
                lines.append(f"      {preset.notes}")
        lines.append("")
    lines.append("Required URL syntax:")
    for protocol, syntax in SYNTAX_BY_PROTOCOL.items():
        lines.append(f"  {protocol}: {syntax}")
    lines.append("")
    lines.append("MOQ upload pipes fragmented MP4 from ffmpeg into openmoq-publisher.")
    return "\n".join(lines)


def _template_field_name(env_var: str) -> str:
    return env_var.lower()


def resolve_preset(preset_id: str) -> DestinationProfile:
    preset = PRESET_BY_ID.get(preset_id)
    if preset is None:
        raise DestinationConfigError(f"Unknown preset: {preset_id}")

    if preset.url:
        url = preset.url
    else:
        if not preset.web_available:
            raise DestinationConfigError(
                f"Ingest endpoint '{preset.name}' is not configured yet for {preset.protocol.upper()}."
            )
        values = {env_var: os.environ.get(env_var, "").strip() for env_var in preset.env_vars}
        missing = [env_var for env_var, value in values.items() if not value]
        if missing:
            raise DestinationConfigError(
                f"Preset '{preset_id}' requires environment variables: {', '.join(missing)}"
            )
        format_values = {_template_field_name(env_var): value for env_var, value in values.items()}
        url = preset.url_template.format(**format_values)

    validate_destination_url(preset.protocol, url)
    placement = merge_placement(
        cloud_provider=preset.cloud_provider,
        cloud_region=preset.cloud_region,
        ingest_provider=preset.ingest_provider,
    )
    return DestinationProfile(
        protocol=preset.protocol,
        url=url,
        label=preset.name,
        preset_id=preset.id,
        ingest_provider=preset.ingest_provider,
        cloud_provider=placement.cloud_provider,
        cloud_region=placement.cloud_region,
    )


def validate_destination_url(protocol: str, url: str) -> None:
    if protocol not in SUPPORTED_PROTOCOLS:
        raise DestinationConfigError(f"Unsupported protocol: {protocol}")

    parsed = urlparse(url)
    expected_schemes = {
        "srt": {"srt"},
        "rtmp": {"rtmp"},
        "hls": {"http", "https"},
        "dash": {"http", "https"},
        "http": {"http", "https"},
        "webrtc": {"http", "https", "whip"},
        "moq": {"https", "moqt"},
    }
    allowed = expected_schemes[protocol]
    if parsed.scheme not in allowed:
        raise DestinationConfigError(
            f"Invalid {protocol} URL scheme '{parsed.scheme or '(none)'}'. "
            f"Expected: {', '.join(sorted(allowed))}. "
            f"Required syntax: {SYNTAX_BY_PROTOCOL[protocol]}"
        )

    if protocol in {"srt", "rtmp"} and not parsed.netloc:
        raise DestinationConfigError(
            f"Invalid {protocol} URL (missing host). "
            f"Required syntax: {SYNTAX_BY_PROTOCOL[protocol]}"
        )

    if protocol in {"hls", "dash", "http", "webrtc"} and not parsed.netloc:
        raise DestinationConfigError(
            f"Invalid {protocol} URL (missing host). "
            f"Required syntax: {SYNTAX_BY_PROTOCOL[protocol]}"
        )

    if protocol == "moq":
        try:
            parse_moq_publish_url(url)
        except ValueError as exc:
            raise DestinationConfigError(str(exc)) from exc


def destination_from_custom(protocol: str, url: str, label: str = "Custom") -> DestinationProfile:
    url = url.strip()
    validate_destination_url(protocol, url)
    return DestinationProfile(protocol=protocol, url=url, label=label)


def _read_choice(prompt: str, valid: Optional[set] = None) -> str:
    while True:
        choice = input(prompt).strip()
        if not valid or choice in valid:
            return choice
        print(f"Invalid choice. Expected one of: {', '.join(sorted(valid))}")


def _prompt_custom_url(protocol: str) -> DestinationProfile:
    print("")
    print(f"Required syntax: {SYNTAX_BY_PROTOCOL[protocol]}")
    while True:
        url = input("Endpoint URL: ").strip()
        try:
            return destination_from_custom(protocol, url)
        except DestinationConfigError as exc:
            print(f"Invalid URL: {exc}")


def _prompt_protocol() -> str:
    print("")
    print("Select upload protocol:")
    for index, protocol in enumerate(SUPPORTED_PROTOCOLS, start=1):
        print(f"  {index}) {PROTOCOL_LABELS[protocol]}")
    choice = _read_choice(f"Selection [1-{len(SUPPORTED_PROTOCOLS)}]: ", {str(i) for i in range(1, len(SUPPORTED_PROTOCOLS) + 1)})
    return SUPPORTED_PROTOCOLS[int(choice) - 1]


def _prompt_endpoint_for_protocol(protocol: str) -> DestinationProfile:
    presets = [preset for preset in SERVICE_PRESETS if preset.protocol == protocol]
    print("")
    print(f"Configure {PROTOCOL_LABELS[protocol]} endpoint:")
    print(f"Required syntax: {SYNTAX_BY_PROTOCOL[protocol]}")
    print("")
    for index, preset in enumerate(presets, start=1):
        env_note = f" [env: {', '.join(preset.env_vars)}]" if preset.env_vars else ""
        print(f"  {index}) {preset.name} ({preset.id}){env_note}")
        if preset.notes:
            print(f"     {preset.notes}")

    custom_option = str(len(presets) + 1)
    print(f"  {custom_option}) Enter a custom URL")
    valid = {str(i) for i in range(1, len(presets) + 2)}
    selection = _read_choice(f"Selection [1-{custom_option}]: ", valid)

    if selection == custom_option:
        return _prompt_custom_url(protocol)

    preset = presets[int(selection) - 1]
    try:
        return resolve_preset(preset.id)
    except DestinationConfigError as exc:
        print(f"Could not use preset '{preset.id}': {exc}")
        print("Enter the URL manually instead.")
        return _prompt_custom_url(protocol)


def prompt_destination() -> DestinationProfile:
    if not sys.stdin.isatty():
        raise DestinationConfigError(
            "Interactive setup requires a TTY. "
            "Use --endpoint-url and --protocol, or --preset."
        )

    print("")
    print("=== Video Upload Benchmark ===")
    protocol = _prompt_protocol()
    return _prompt_endpoint_for_protocol(protocol)


def presets_for_api(*, web_only: bool = False) -> List[dict]:
    presets = SERVICE_PRESETS
    if web_only:
        presets = [preset for preset in SERVICE_PRESETS if preset.web_visible]
    return [
        {
            "id": preset.id,
            "name": preset.name,
            "protocol": preset.protocol,
            "url": preset.url,
            "notes": preset.notes,
            "env_vars": list(preset.env_vars),
            "requires_env": bool(preset.env_vars),
            "supports_vmaf": preset.supports_vmaf,
            "ingest_provider": preset.ingest_provider,
            "cloud_provider": preset.cloud_provider
            or placement_from_ingest_provider(preset.ingest_provider).cloud_provider,
            "cloud_region": preset.cloud_region
            or placement_from_ingest_provider(preset.ingest_provider).cloud_region,
            "web_available": preset.web_available,
        }
        for preset in presets
    ]


def resolve_destination_request(
    preset_id: Optional[str] = None,
    protocol: Optional[str] = None,
    endpoint_url: Optional[str] = None,
) -> DestinationProfile:
    if preset_id:
        return resolve_preset(preset_id)
    if protocol and endpoint_url:
        return destination_from_custom(protocol, endpoint_url, label="Web")
    raise DestinationConfigError(
        "Provide either preset_id or both protocol and endpoint_url"
    )


def resolve_cli_destination(args) -> DestinationProfile:
    if args.preset:
        return resolve_preset(args.preset)
    if args.endpoint_url:
        if not args.protocol:
            raise DestinationConfigError("--protocol is required when using --endpoint-url")
        return destination_from_custom(args.protocol, args.endpoint_url, label="CLI")
    raise DestinationConfigError(
        "Non-interactive mode requires --preset or --endpoint-url with --protocol"
    )
