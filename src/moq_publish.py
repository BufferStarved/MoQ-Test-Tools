import os
import shutil
import subprocess
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import parse_qs, quote, urlparse, urlunparse


DEFAULT_MOQ_NAMESPACE = "benchmark"
DEFAULT_MOQ_DRAFT = 16
DEFAULT_MOQ_FORWARD = 1
# NOTE: openmoq-publisher's forward=0 "await-subscribe" mode never receives a
# downstream SUBSCRIBE notification from the moqx relay used here (confirmed by
# direct testing: relay reports subscribe_success, but the publisher process log
# stays on "awaiting subscriptions, mode=await-subscribe" forever, sending zero
# media objects). forward=1 proactively streams GOPs regardless of subscriber
# presence, which is the only mode that has produced actual rendered frames
# against this relay. Keep forward=1 unless moqx adds SUBSCRIBE forwarding.
OPENMOQ_PUBLISHER_VERSION = "v0.3.2"
DEFAULT_MOQ_PUBLISHER_BACKEND = "auto"  # auto | moq5 | openmoq

# Default H.264 Main + yuv420p ladder (720p). Prefer build_video_encode_args()
# from encode_profile when the UI supplies ladder + target latency.
from encode_profile import (  # noqa: E402
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_TARGET_LATENCY_MS,
    build_video_encode_args,
)

BROWSER_COMPAT_VIDEO_ARGS = build_video_encode_args(
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_TARGET_LATENCY_MS,
)
# +bitexact is required, not cosmetic: ffmpeg's native AAC encoder embeds its
# version string ("Lavc62.28.102\0") as literal bytes inside the FIRST access
# unit of every encoded AAC frame (a libavcodec "fill_element" comment, not
# container metadata — map_metadata -1 does NOT touch it). Chrome's MSE AAC
# decoder treats that non-standard payload as corrupt, fires a genuine
# SourceBuffer 'error' event, and Chrome then invalidates the *entire*
# MediaSource — which is what produced the cascading "This SourceBuffer has
# been removed from the parent media source" appendBuffer failures on both
# audio AND video tracks. Confirmed by hexdumping ffmpeg's raw mdat output
# with/without this flag: removes 100% of the in-bitstream "Lavc..." bytes.
BROWSER_COMPAT_AUDIO_ARGS = [
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-flags:a", "+bitexact",
]

# ffmpeg WHIP muxer accepts Opus only (AAC → exit 234 "Conversion failed!").
WHIP_COMPAT_AUDIO_ARGS = [
    "-c:a", "libopus", "-b:a", "128k", "-ar", "48000", "-ac", "2",
]

# MP4 → MPEG-TS for SRT/Zixi. repeat-headers=1 (above) injects SPS/PPS at IDR; annex-B converts AVCC.
# Chained bsf syntax (dump_extra+…) is not supported on Homebrew ffmpeg-full.
MPEGTS_VIDEO_BSF = "h264_mp4toannexb"


def _ffmpeg_has_srt_output(ffmpeg_bin: str) -> bool:
    """True when this ffmpeg binary can mux/publish ``srt://`` outputs."""
    try:
        probe = subprocess.run(
            [ffmpeg_bin, "-protocols"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    text = f"{probe.stdout or ''}\n{probe.stderr or ''}"
    # Protocol lists are split into Input:/Output: sections; require Output srt.
    out_section = ""
    if "Output:" in text:
        out_section = text.split("Output:", 1)[1]
        if "\nInput:" in out_section:
            out_section = out_section.split("\nInput:", 1)[0]
    else:
        out_section = text
    return any(tok == "srt" for tok in out_section.replace("\n", " ").split())


def find_ffmpeg() -> str:
    """Prefer an ffmpeg that can speak SRT (Homebrew ffmpeg-full), not PATH ffmpeg."""
    override = os.environ.get("FFMPEG", "").strip()
    if override and os.path.isfile(override) and os.access(override, os.X_OK):
        return override
    candidates = [
        "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
        "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
        shutil.which("ffmpeg"),
    ]
    existing = [
        c for c in candidates if c and os.path.isfile(c) and os.access(c, os.X_OK)
    ]
    for candidate in existing:
        if _ffmpeg_has_srt_output(candidate):
            return candidate
    if existing:
        return existing[0]
    return "ffmpeg"


@dataclass(frozen=True)
class MoqPublishTarget:
    endpoint: str
    namespace: str
    transport: str = "webtransport"
    draft: int = DEFAULT_MOQ_DRAFT
    forward: int = DEFAULT_MOQ_FORWARD
    insecure_tls: bool = False


def zixi_srt_stream_id_for_preset(preset_id: str) -> Optional[str]:
    if preset_id == "moq_zixi_gcp":
        return "SRT Test"
    return None


def zixi_http_push_stream_id_for_preset(preset_id: str) -> Optional[str]:
    """Stream ID for Zixi TS-over-HTTP push presets (HLS/DASH ingest buttons)."""
    if preset_id in {"moq_zixi_gcp_hls", "moq_zixi_gcp_dash"}:
        return "benchmark"
    return None


def mediamtx_loopback_enabled() -> bool:
    """Whether publish URLs should rewrite MediaMTX's public IP → 127.0.0.1.

    Required on the co-located web VM (hairpin to the external IP fails).
    Must stay **off** on laptop publisher agents and other remote encoders.
    """
    raw = (os.environ.get("MEDIAMTX_LOOPBACK_PUBLISH") or "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    # Auto-detect: MediaMTX control API on loopback (present on moq-web, not laptops).
    try:
        import urllib.error
        import urllib.request

        urllib.request.urlopen("http://127.0.0.1:9997/v3/config/global/get", timeout=0.25)
        return True
    except (OSError, urllib.error.URLError, TimeoutError, ValueError):
        return False


def mediamtx_loopback_publish_url(url: str) -> str:
    """Rewrite co-located MediaMTX public host → 127.0.0.1 for ffmpeg publish.

    GCP VMs typically cannot hairpin to their own external IP, so publishing
    SRT/RTMP/WHIP from moq-web to ``34.x.x.x`` often dies after a few seconds.
    Browser playback URLs keep the public host; only the publish endpoint is
    localized. Override with ``MEDIAMTX_PUBLIC_HOST`` (comma-separated hosts).

    Set ``MEDIAMTX_LOOPBACK_PUBLISH=0`` on local publisher agents.
    """
    text = (url or "").strip()
    if not text or not mediamtx_loopback_enabled():
        return url
    hosts = [
        h.strip()
        for h in os.environ.get("MEDIAMTX_PUBLIC_HOST", "34.9.217.178").split(",")
        if h.strip()
    ]
    parsed = urlparse(text)
    hostname = parsed.hostname or ""
    if hostname not in hosts:
        return url
    # Preserve userinfo / port / path / query; swap host only.
    userinfo = ""
    if parsed.username is not None:
        userinfo = parsed.username
        if parsed.password is not None:
            userinfo += f":{parsed.password}"
        userinfo += "@"
    port = f":{parsed.port}" if parsed.port else ""
    netloc = f"{userinfo}127.0.0.1{port}"
    return urlunparse(
        (parsed.scheme, netloc, parsed.path, parsed.params, parsed.query, parsed.fragment)
    )


def zixi_srt_streamid_value(stream_id: str) -> str:
    """Build the SRT streamid payload Zixi expects on caller/push connections."""
    mode = os.environ.get("ZIXI_SRT_STREAMID_MODE", "access").strip().lower()
    if mode in {"plain", "name", "simple"}:
        return stream_id
    return f"#!::r={stream_id},m=publish"


def with_srt_stream_id(url: str, stream_id: str) -> str:
    """Attach Zixi stream ID to an srt:// URL (required when Verify Stream ID is enabled)."""
    parsed = urlparse(url.strip())
    if parsed.scheme != "srt":
        return url
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (query.get("streamid") or [""])[0].strip():
        return url
    query["streamid"] = [zixi_srt_streamid_value(stream_id)]
    # Preserve Zixi ``#!::r=…`` and MediaMTX ``publish:path`` streamid forms.
    flat_query = "&".join(
        f"{key}={quote(values[-1], safe=':#!/@=,')}" for key, values in query.items() if values
    )
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, flat_query, parsed.fragment))


def find_moq5_publisher() -> Optional[str]:
    override = os.environ.get("MOQ5_PUBLISHER_BIN", "").strip()
    if override and os.path.isfile(override) and os.access(override, os.X_OK):
        return override

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    candidates = [
        os.path.join(repo_root, "tools", "moq5-publisher", "bin", "moq5-fmp4-publish"),
        os.path.expanduser("~/.local/bin/moq5-fmp4-publish"),
        shutil.which("moq5-fmp4-publish"),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def resolve_moq_publisher_backend() -> str:
    backend = os.environ.get("MOQ_PUBLISHER_BACKEND", DEFAULT_MOQ_PUBLISHER_BACKEND).strip().lower()
    if backend not in {"auto", "moq5", "openmoq"}:
        raise ValueError(
            f"Invalid MOQ_PUBLISHER_BACKEND '{backend}'. Expected auto, moq5, or openmoq."
        )
    return backend


def find_moq_publisher() -> tuple[Optional[str], str]:
    """Return (binary_path, backend_name)."""
    backend = resolve_moq_publisher_backend()
    moq5_bin = find_moq5_publisher()
    openmoq_bin = find_openmoq_publisher()

    if backend == "moq5":
        return moq5_bin, "moq5"
    if backend == "openmoq":
        return openmoq_bin, "openmoq"

    # openmoq-publisher is the known-good path for moqx relays (catalog + vide_1/soun_2).
    # moq5-fmp4-publish is experimental (single-track init parse, no --publish-catalog parity).
    if openmoq_bin:
        return openmoq_bin, "openmoq"
    if moq5_bin:
        return moq5_bin, "moq5"
    return openmoq_bin, "openmoq"


def find_openmoq_publisher() -> Optional[str]:
    override = os.environ.get("OPENMOQ_PUBLISHER_BIN", "").strip()
    if override and os.path.isfile(override) and os.access(override, os.X_OK):
        return override

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    candidates = [
        os.path.join(repo_root, "tools", "openmoq-publisher", "bin", "openmoq-publisher"),
        os.path.expanduser("~/.local/bin/openmoq-publisher"),
        shutil.which("openmoq-publisher"),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def parse_moq_publish_url(url: str) -> MoqPublishTarget:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"https", "http", "moqt"}:
        raise ValueError(
            f"Invalid MOQ publish URL scheme '{parsed.scheme or '(none)'}'. "
            "Expected https://<relay-host>:4433/moq-relay?namespace=benchmark"
        )
    if not parsed.netloc:
        raise ValueError("Invalid MOQ publish URL (missing host).")

    if parsed.scheme == "moqt":
        endpoint = f"moqt://{parsed.netloc}{parsed.path or '/moq-relay'}"
        transport = "raw"
    else:
        endpoint = f"{parsed.scheme}://{parsed.netloc}{parsed.path or '/moq-relay'}"
        transport = "webtransport"

    query = parse_qs(parsed.query)
    namespace = (query.get("namespace") or [DEFAULT_MOQ_NAMESPACE])[0].strip() or DEFAULT_MOQ_NAMESPACE
    draft_raw = (query.get("draft") or [str(DEFAULT_MOQ_DRAFT)])[0]
    try:
        draft = int(draft_raw)
    except ValueError as exc:
        raise ValueError(f"Invalid MOQ draft query parameter: {draft_raw}") from exc

    forward_raw = (query.get("forward") or [str(DEFAULT_MOQ_FORWARD)])[0]
    try:
        forward = int(forward_raw)
    except ValueError as exc:
        raise ValueError(f"Invalid MOQ forward query parameter: {forward_raw}") from exc

    hostname = (parsed.hostname or "").lower()
    insecure_tls = hostname.endswith(".sslip.io") or os.environ.get("MOQ_PUBLISHER_INSECURE", "") == "1"

    return MoqPublishTarget(
        endpoint=endpoint,
        namespace=namespace,
        transport=transport,
        draft=draft,
        forward=forward,
        insecure_tls=insecure_tls,
    )


def is_live_media_source(media_path: str) -> bool:
    """True for live UDP/TCP/RTSP inputs (already realtime — do not use -re)."""
    value = (media_path or "").strip().lower()
    return value.startswith(("udp://", "tcp://", "rtsp://", "srt://"))


def build_ffmpeg_input_args(media_path: str, *, duration_sec: Optional[int] = None) -> List[str]:
    if is_live_media_source(media_path):
        # Webcam bridge → UDP is often VFR / discontinuous; regenerate PTS so
        # the second encode + MoQ fMP4 tfdt stay monotonic.
        return [
            "-fflags",
            "+nobuffer+genpts+discardcorrupt+igndts",
            "-flags",
            "low_delay",
            "-use_wallclock_as_timestamps",
            "1",
            "-probesize",
            "32k",
            "-analyzeduration",
            "0",
            "-i",
            media_path,
        ]
    args = ["-re", "-i", media_path]
    # Hard-cap file encodes to the job duration so ffmpeg cannot outrun the
    # media (or hang past EOF waiting on a network muxer).
    if duration_sec is not None and duration_sec > 0:
        args.extend(["-t", str(int(duration_sec))])
    return args


def build_ffmpeg_moq_cmd(
    media_path: str,
    *,
    progress_path: str,
    encode_ladder: str = DEFAULT_ENCODE_LADDER_ID,
    target_latency_ms: int = DEFAULT_TARGET_LATENCY_MS,
    duration_sec: Optional[int] = None,
) -> List[str]:
    video_args = build_video_encode_args(encode_ladder, target_latency_ms)
    return [
        find_ffmpeg(),
        *build_ffmpeg_input_args(media_path, duration_sec=duration_sec),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "-1",
        "-sn",
        "-dn",
        *video_args,
        *BROWSER_COMPAT_AUDIO_ARGS,
        "-progress",
        progress_path,
        "-nostats",
        # Keep fMP4 decode times near zero-based; fragment on keyframes for MoQ CMAF.
        "-muxdelay",
        "0",
        "-muxpreload",
        "0",
        "-movflags",
        "+frag_keyframe+empty_moov+default_base_moof+separate_moof",
        "-f",
        "mp4",
        "pipe:1",
    ]


def build_moq5_publisher_cmd(
    publisher_bin: str,
    target: MoqPublishTarget,
    *,
    duration_sec: int,
    qlog_dir: str = "",
) -> List[str]:
    cmd = [
        publisher_bin,
        target.endpoint,
        target.namespace,
        *(["--insecure-skip-verify"] if target.insecure_tls else []),
        "--duration",
        str(duration_sec),
    ]
    if qlog_dir:
        cmd.extend(["--qlog-dir", qlog_dir])
    return cmd


def build_moq_publisher_cmd(
    publisher_bin: str,
    backend: str,
    target: MoqPublishTarget,
    *,
    duration_sec: int,
    qlog_dir: str = "",
    paced: bool = True,
) -> List[str]:
    if backend == "moq5":
        return build_moq5_publisher_cmd(
            publisher_bin,
            target,
            duration_sec=duration_sec,
            qlog_dir=qlog_dir,
        )
    return build_openmoq_publisher_cmd(
        publisher_bin,
        target,
        duration_sec=duration_sec,
        paced=paced,
    )


def build_openmoq_publisher_cmd(
    publisher_bin: str,
    target: MoqPublishTarget,
    *,
    duration_sec: int,
    paced: bool = True,
) -> List[str]:
    timeout_sec = max(duration_sec + 60, 120)
    # --paced delays object sends to media timestamps. For live webcam/UDP the
    # encode is already realtime; pacing stacks delay and makes browser playback
    # fall behind the live edge. Keep paced for VOD file publishes only.
    cmd = [
        publisher_bin,
        "--input",
        "-",
        "--transport",
        target.transport,
        "--endpoint",
        target.endpoint,
        "--namespace",
        target.namespace,
        "--draft",
        str(target.draft),
        "--forward",
        str(target.forward),
        "--timeout",
        str(timeout_sec),
        "--publish-catalog",
        *(["--insecure"] if target.insecure_tls else []),
    ]
    if paced:
        cmd.append("--paced")
    return cmd
