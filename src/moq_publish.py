import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Callable, List, Optional
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
OPENMOQ_PUBLISHER_VERSION = "v0.3.2"  # keep in sync with scripts/install-openmoq-publisher.sh default
DEFAULT_MOQ_PUBLISHER_BACKEND = "auto"  # auto | moq5 | openmoq

# Default H.264 Main + yuv420p ladder (720p). Prefer build_video_encode_args()
# from encode_profile when the UI supplies ladder + target latency.
from encode_profile import (  # noqa: E402
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_TARGET_LATENCY_MS,
    build_video_encode_args,
    moq_gop_frames_for_latency,
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


WHIP_FFMPEG_HINT = (
    "This laptop cannot publish WebRTC yet. Use SRT, RTMP, or MoQ, "
    "or Cloud playout / Browser."
)


def ffmpeg_has_whip_muxer(ffmpeg_bin: str) -> bool:
    """True when this binary can mux `-f whip` (not just speak HTTP)."""
    if not ffmpeg_bin:
        return False
    try:
        probe = subprocess.run(
            [ffmpeg_bin, "-hide_banner", "-muxers"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    text = f"{probe.stdout or ''}\n{probe.stderr or ''}"
    return bool(re.search(r"(?m)^\s*E\s+whip\b", text))


def whip_ffmpeg_missing_error(ffmpeg_bin: str) -> str:
    path = ffmpeg_bin or "ffmpeg"
    return f"{path}: {WHIP_FFMPEG_HINT}"


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


_ZIXI_SRT_PRESET_IDS = {
    "moq_zixi_gcp",
    "moq_zixi_gcp_east",
    "moq_zixi_linode",
}
_ZIXI_RTMP_PRESET_IDS = {
    "moq_zixi_gcp_rtmp",
    "moq_zixi_gcp_east_rtmp",
    "moq_zixi_linode_rtmp",
}
_ZIXI_HTTP_PUSH_PRESET_IDS = {
    "moq_zixi_gcp_hls",
    "moq_zixi_gcp_dash",
    "moq_zixi_gcp_east_hls",
    "moq_zixi_gcp_east_dash",
    "moq_zixi_linode_hls",
    "moq_zixi_linode_dash",
}


def zixi_srt_stream_id_for_preset(preset_id: str) -> Optional[str]:
    if preset_id in _ZIXI_SRT_PRESET_IDS:
        return "SRT Test"
    return None


def zixi_rtmp_stream_id_for_preset(preset_id: str) -> Optional[str]:
    """Zixi Fast HLS / HTTP-TS stream id for managed RTMP presets."""
    if preset_id in _ZIXI_RTMP_PRESET_IDS:
        return "benchmark"
    return None


def zixi_stream_id_from_rtmp_url(url: str) -> Optional[str]:
    """Extract the RTMP stream key (last path segment) for Fast HLS gating."""
    try:
        path = (urlparse(url).path or "").strip("/")
    except ValueError:
        return None
    if not path:
        return None
    key = path.rsplit("/", 1)[-1].strip()
    return key or None


def zixi_http_push_stream_id_for_preset(preset_id: str) -> Optional[str]:
    """Stream ID for Zixi TS-over-HTTP push presets (HLS/DASH ingest buttons)."""
    if preset_id in _ZIXI_HTTP_PUSH_PRESET_IDS:
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


# Local publisher agent captures the machine camera/mic (not a repo VOD asset).
DEVICE_WEBCAM_MEDIA = "device:webcam"
# In-browser WebCodecs + WebTransport publisher (no laptop ffmpeg agent).
DEVICE_BROWSER_MEDIA = "device:browser"


def is_device_webcam_source(media_path: str) -> bool:
    value = (media_path or "").strip().lower()
    return value == DEVICE_WEBCAM_MEDIA or value.startswith("device:webcam")


def is_device_browser_source(media_path: str) -> bool:
    value = (media_path or "").strip().lower()
    return value == DEVICE_BROWSER_MEDIA or value.startswith("device:browser")


def device_webcam_index(media_path: str) -> Optional[int]:
    """Camera index from a ``device:webcam:N`` media path (None = platform default).

    The UI camera picker appends the index the agent advertised; a malformed
    suffix falls back to the default device rather than failing the job.
    """
    value = (media_path or "").strip().lower()
    prefix = DEVICE_WEBCAM_MEDIA + ":"
    if not value.startswith(prefix):
        return None
    try:
        index = int(value[len(prefix):], 10)
    except ValueError:
        return None
    return index if index >= 0 else None


def is_live_media_source(media_path: str) -> bool:
    """True for live UDP/TCP/RTSP/device inputs (already realtime — do not use -re)."""
    value = (media_path or "").strip().lower()
    return value.startswith(("udp://", "tcp://", "rtsp://", "srt://")) or is_device_webcam_source(
        media_path
    ) or is_device_browser_source(media_path)


def build_device_webcam_input_args(
    *,
    duration_sec: Optional[int] = None,
    device_index: Optional[int] = None,
    video_size: Optional[str] = None,
    framerate: Optional[str] = "30",
) -> List[str]:
    """ffmpeg input args for the laptop camera (local publisher agent).

    macOS: AVFoundation default video+audio (``0:0``).
    Linux: V4L2 ``/dev/video0`` + silent audio (anullsrc) unless Pulse is present.
    ``device_index`` (from the UI camera picker) overrides the video device;
    env vars keep working as the default when no index is given.

    ``video_size`` / ``framerate`` (macOS) request an explicit AVFoundation
    capture mode. OBS Virtual Camera typically lists only ``1920x1080@60`` —
    a rigid ``1280x720@30`` exits 251. Pass ``framerate=None`` (and omit
    size) to let avfoundation negotiate; callers that probe the device
    should pass a supported pair (see ``avfoundation_modes`` and
    ``webcam_broker.py``).
    """
    import platform
    import shutil

    duration_args: List[str] = []
    if duration_sec is not None and duration_sec > 0:
        duration_args = ["-t", str(int(duration_sec))]

    system = platform.system().lower()
    if system == "darwin":
        default_spec = os.environ.get("LOCAL_WEBCAM_AVFOUNDATION", "0:0").strip() or "0:0"
        if device_index is not None:
            # Picker chooses the camera; keep the configured audio input.
            audio_part = default_spec.split(":", 1)[1] if ":" in default_spec else "0"
            input_spec = f"{device_index}:{audio_part}"
        else:
            input_spec = default_spec
        # When a rate is given it must precede -i (avfoundation CFR).
        # Omitting both flags lets the device pick its native mode (OBS 1080p60).
        rate_args = ["-framerate", str(framerate)] if framerate else []
        size_args = ["-video_size", video_size] if video_size else []
        return [
            "-f",
            "avfoundation",
            *rate_args,
            *size_args,
            *duration_args,
            "-i",
            input_spec,
        ]

    # Linux — prefer v4l2 + pulse when available.
    if device_index is not None:
        video_dev = f"/dev/video{device_index}"
    else:
        video_dev = (os.environ.get("LOCAL_WEBCAM_DEVICE") or "/dev/video0").strip() or "/dev/video0"
    if shutil.which("pactl") or os.path.exists("/dev/snd"):
        # Dual input: camera + default Pulse source, then explicit maps later via -map
        # is awkward here; use pulse as audio companion with filter_complex-free
        # lavfi anullsrc fallback for broad compatibility.
        pass
    return [
        "-f",
        "v4l2",
        "-framerate",
        "30",
        "-video_size",
        "1280x720",
        *duration_args,
        "-i",
        video_dev,
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
    ]


def build_ffmpeg_input_args(media_path: str, *, duration_sec: Optional[int] = None) -> List[str]:
    if is_device_webcam_source(media_path):
        return build_device_webcam_input_args(
            duration_sec=duration_sec,
            device_index=device_webcam_index(media_path),
        )
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
    vmaf_reference_path: str = "",
) -> List[str]:
    # MoQ must NOT use the shared latency-sized GOP: openmoq ships one CMAF
    # fragment (= one GOP via frag_keyframe) per MoQ group/object, and the
    # player joins on NextGroupStart with no rate catch-up — so GOP duration
    # is paid twice (fragment accumulation + join offset) and persists all
    # session. See moq_gop_frames_for_latency for the sizing rationale.
    wallclock_pts = is_live_media_source(media_path) and not is_device_webcam_source(media_path)
    video_args = build_video_encode_args(
        encode_ladder,
        target_latency_ms,
        gop_frames=moq_gop_frames_for_latency(target_latency_ms),
        wallclock_pts=wallclock_pts,
    )
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
        # Optional second output: stream-copy of the exact consumed input,
        # used as the VMAF reference for live sources (no file to score
        # against). -c:v copy applies to this output only.
        *(
            ["-map", "0:v:0", "-c:v", "copy", "-f", "mpegts", vmaf_reference_path]
            if vmaf_reference_path
            else []
        ),
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
    paced: bool = False,
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


def should_pace_moq_publisher(media_path: str = "") -> bool:
    """Whether openmoq-publisher should get ``--paced``.

    Always false: ffmpeg already rate-limits (``-re`` on files, live sources
    are realtime). Stacking ``--paced`` on top delayed PUBLISH_NAMESPACE until
    the first media timestamp and produced encode-only jobs whose relay never
    saw the namespace (bench-733f1d7c: 240 CMAF fragments, moqx_ns=0).
    """
    del media_path
    return False


def publisher_webtransport_connected(log_text: str) -> bool:
    """True when openmoq-publisher logged a live WebTransport session.

    ``connection_id=wt-…`` goes to stdout (libc-block-buffered inside Docker,
    so it may land in the drain file only after exit). ``live: sent track=``
    on stderr is the same fact: objects already went out on that session.
    bench-216482ff had both, and the waiter still called it "before CONNECT"
    because it only looked for ``connection_id=`` in a prefix of stdout.
    """
    text = log_text or ""
    return "connection_id=" in text or "live: sent track=" in text


def publisher_exit_error(backend: str, code: Optional[int], log_text: str) -> str:
    """Human error for a publisher that died. Never lie about CONNECT.

    Exit -9 is SIGKILL of our Docker wrapper (or the OOM killer). If the
    log already shows a session, that is a teardown/OOM of a live publish,
    not a failed WebTransport CONNECT.
    """
    detail = (log_text or "").strip() or "unknown error"
    connected = publisher_webtransport_connected(detail)
    if connected:
        if code in (-9, 137):
            return (
                f"{backend} publisher was SIGKILL'd after WebTransport CONNECT "
                f"(exit {code}; Docker-wrapper teardown or OOM — not a failed "
                f"CONNECT). {detail}"
            )
        return (
            f"{backend} publisher exited with code {code} after "
            f"WebTransport CONNECT: {detail}"
        )
    if code not in (0, None):
        return (
            f"{backend} publisher exited with code {code} "
            f"before WebTransport CONNECT: {detail}"
        )
    return (
        f"{backend} publisher exited early before WebTransport CONNECT: {detail}"
    )


# Docker-wrapped openmoq-publisher pays container startup before CONNECT.
# ffmpeg must not write CMAF until that line appears (bench-733f1d7c).
PUBLISHER_WEBTRANSPORT_WAIT_SEC = 20.0


def wait_for_publisher_webtransport(
    read_log: Callable[[], str],
    is_alive: Callable[[], bool],
    *,
    timeout_sec: float = PUBLISHER_WEBTRANSPORT_WAIT_SEC,
    poll_interval: float = 0.1,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """Block until stdout/stderr shows a live session, or give up.

    A live session is ``connection_id=`` or ``live: sent track=``. Returns
    False if the publisher dies or the timeout elapses. Do not SIGKILL a
    publisher that already printed either line — that is mid-publish.
    """
    deadline = clock() + max(0.0, timeout_sec)
    while clock() < deadline:
        connected = publisher_webtransport_connected(read_log())
        alive = is_alive()
        if connected and alive:
            return True
        if not alive:
            return False
        sleep(poll_interval)
    return publisher_webtransport_connected(read_log()) and is_alive()


def build_openmoq_publisher_cmd(
    publisher_bin: str,
    target: MoqPublishTarget,
    *,
    duration_sec: int,
    paced: bool = False,
) -> List[str]:
    timeout_sec = max(duration_sec + 60, 120)
    # --paced is off by default: ffmpeg is already realtime. See
    # should_pace_moq_publisher.
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
