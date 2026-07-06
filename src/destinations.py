import os
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse


class DestinationConfigError(Exception):
    """Raised when a destination URL or preset cannot be resolved."""


SUPPORTED_PROTOCOLS = ("srt", "rtmp", "http", "webrtc")

SYNTAX_BY_PROTOCOL = {
    "srt": "srt://<host>:<port>?mode=caller&latency=<microseconds>[&streamid=<id>]",
    "rtmp": "rtmp://<host>[:<port>]/<application>/<stream-key>",
    "http": "https://<host>/<path> (presigned PUT URL) or http://127.0.0.1:9000/<bucket>/<object-key>",
    "webrtc": "https://<host>/<whip-path> or whip://<host>/<path>",
}

PROTOCOL_LABELS = {
    "srt": "SRT ingest",
    "rtmp": "RTMP ingest",
    "http": "HTTP upload (presigned PUT)",
    "webrtc": "WebRTC (WHIP)",
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


@dataclass
class DestinationProfile:
    protocol: str
    url: str
    label: str = ""
    preset_id: str = ""

    def ffmpeg_output_args(self) -> List[str]:
        if self.protocol == "srt":
            return ["-f", "mpegts", self.url]
        if self.protocol == "rtmp":
            return ["-f", "flv", self.url]
        if self.protocol == "http":
            return [
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov",
                "-method", "PUT",
                self.url,
            ]
        if self.protocol == "webrtc":
            return ["-f", "whip", self.url]
        raise DestinationConfigError(f"Unsupported protocol: {self.protocol}")


SERVICE_PRESETS: List[ServicePreset] = [
    ServicePreset(
        id="local_srs_srt",
        name="Local SRS SRT listener",
        protocol="srt",
        url="srt://127.0.0.1:10080?mode=caller&latency=200000",
        notes="Run: docker run -p 10080:10080 ossrs/srs:5",
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
    ),
    ServicePreset(
        id="gcore_srt",
        name="Gcore SRT ingest",
        protocol="srt",
        url_template="{gcore_srt_push_url}",
        env_vars=("GCORE_SRT_PUSH_URL",),
        notes="Set GCORE_SRT_PUSH_URL to the full srt:// URL from Gcore.",
    ),
    ServicePreset(
        id="local_rtmp",
        name="Local RTMP server",
        protocol="rtmp",
        url="rtmp://127.0.0.1:1935/live/benchmark",
        notes="Requires a local RTMP listener on port 1935.",
    ),
    ServicePreset(
        id="antmedia_rtmp",
        name="Ant Media Server RTMP",
        protocol="rtmp",
        url_template="{ant_media_rtmp_url}",
        env_vars=("ANT_MEDIA_RTMP_URL",),
        notes="Example: rtmp://your-server/LiveApp/streamId",
    ),
    ServicePreset(
        id="minio_put",
        name="Local MinIO presigned PUT",
        protocol="http",
        url_template="{minio_put_url}",
        env_vars=("MINIO_PUT_URL",),
        notes="Set MINIO_PUT_URL to a presigned PUT URL.",
    ),
    ServicePreset(
        id="s3_presigned_put",
        name="AWS S3 presigned PUT",
        protocol="http",
        url_template="{s3_presigned_put_url}",
        env_vars=("S3_PRESIGNED_PUT_URL",),
    ),
    ServicePreset(
        id="r2_presigned_put",
        name="Cloudflare R2 presigned PUT",
        protocol="http",
        url_template="{r2_presigned_put_url}",
        env_vars=("R2_PRESIGNED_PUT_URL",),
    ),
    ServicePreset(
        id="local_whip",
        name="Local WHIP endpoint",
        protocol="webrtc",
        url="http://127.0.0.1:8080/whip/endpoint",
        notes="Requires a local WHIP-capable server.",
    ),
    ServicePreset(
        id="whip_env",
        name="WHIP endpoint from WHIP_URL",
        protocol="webrtc",
        url_template="{whip_url}",
        env_vars=("WHIP_URL",),
    ),
]

PRESET_BY_ID: Dict[str, ServicePreset] = {preset.id: preset for preset in SERVICE_PRESETS}


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
    lines.append("MoQ support is planned for a future release.")
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
        values = {env_var: os.environ.get(env_var, "").strip() for env_var in preset.env_vars}
        missing = [env_var for env_var, value in values.items() if not value]
        if missing:
            raise DestinationConfigError(
                f"Preset '{preset_id}' requires environment variables: {', '.join(missing)}"
            )
        format_values = {_template_field_name(env_var): value for env_var, value in values.items()}
        url = preset.url_template.format(**format_values)

    validate_destination_url(preset.protocol, url)
    return DestinationProfile(
        protocol=preset.protocol,
        url=url,
        label=preset.name,
        preset_id=preset.id,
    )


def validate_destination_url(protocol: str, url: str) -> None:
    if protocol not in SUPPORTED_PROTOCOLS:
        raise DestinationConfigError(f"Unsupported protocol: {protocol}")

    parsed = urlparse(url)
    expected_schemes = {
        "srt": {"srt"},
        "rtmp": {"rtmp"},
        "http": {"http", "https"},
        "webrtc": {"http", "https", "whip"},
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

    if protocol in {"http", "webrtc"} and not parsed.netloc:
        raise DestinationConfigError(
            f"Invalid {protocol} URL (missing host). "
            f"Required syntax: {SYNTAX_BY_PROTOCOL[protocol]}"
        )


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
    choice = _read_choice("Selection [1-4]: ", {"1", "2", "3", "4"})
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


def presets_for_api() -> List[dict]:
    return [
        {
            "id": preset.id,
            "name": preset.name,
            "protocol": preset.protocol,
            "notes": preset.notes,
            "env_vars": list(preset.env_vars),
            "requires_env": bool(preset.env_vars),
        }
        for preset in SERVICE_PRESETS
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
