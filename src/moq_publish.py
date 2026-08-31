import errno
import logging
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from typing import Callable, List, Optional
from urllib.parse import parse_qs, quote, urlparse, urlunparse

logger = logging.getLogger("MoQ-SRT-Bench")

DEFAULT_MOQ_NAMESPACE = "benchmark"
DEFAULT_MOQ_DRAFT = 18
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
from avfoundation_modes import PREFERRED_FPS, PREFERRED_SIZE  # noqa: E402
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
    """Prefer an ffmpeg that can speak SRT (Homebrew ffmpeg-full), not PATH ffmpeg.

    An explicit ``FFMPEG`` override always wins — it is the escape hatch for
    testing a purpose-built binary. But it also skips the SRT capability check
    the candidate search exists to perform, so a build made for one protocol
    silently becomes the binary for all of them. The patched WHIP build from
    tools/ffmpeg-whip is exactly that shape: it reports ``http rtmp rtmps tcp
    udp`` and no ``srt``, so exporting it globally would route SRT publishes to
    a binary that cannot speak SRT. Honour the override, but never let that
    happen quietly.
    """
    override = os.environ.get("FFMPEG", "").strip()
    if override and os.path.isfile(override) and os.access(override, os.X_OK):
        if not _ffmpeg_has_srt_output(override):
            logger.warning(
                "FFMPEG override %s has no srt output protocol; SRT publishes "
                "with this binary will fail. Scope the override to the "
                "protocol you are testing, or rebuild it with --enable-libsrt.",
                override,
            )
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
        # Local cmake build (install-moq5.sh copies this to bin/).
        os.path.join(repo_root, "tools", "moq5-publisher", "build", "moq5-fmp4-publish"),
        os.path.expanduser("~/.local/bin/moq5-fmp4-publish"),
        shutil.which("moq5-fmp4-publish"),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


MOQ5_MISSING_HINT = "moq5-fmp4-publish not found, run scripts/install-moq5.sh"


def _with_moq_spawn_context(message: str, *, binary: str = "", relay_url: str = "") -> str:
    extras: List[str] = []
    if relay_url and relay_url not in message:
        extras.append(f"relay={relay_url}")
    if binary and binary not in message:
        extras.append(f"binary={binary}")
    if not extras:
        return message
    return f"{message.rstrip('.')} ({', '.join(extras)})."


CAMERA_EIO_HINT = (
    "The camera may be busy, unplugged, "
    "or already open in another app (AVFoundation exclusive open)."
)
PIPE_EIO_HINT = (
    "The encoder wrote to a closed publisher pipe "
    "(publisher exited before CMAF init, or stdin was not attached yet)."
)


def is_bare_eio_message(text: str) -> bool:
    """True for a raw ``[Errno 5] Input/output error`` with no classifier prefix."""
    stripped = (text or "").strip()
    if not stripped:
        return False
    lower = stripped.lower()
    if lower in {"[errno 5] input/output error", "input/output error"}:
        return True
    return (
        lower.startswith("[errno 5]")
        and "input/output error" in lower
        and "camera i/o" not in lower
        and "failed to start moq publisher" not in lower
        and "obs websocket" not in lower
        and len(stripped) < 80
    )


def looks_like_camera_eio(text: str) -> bool:
    """True when the I/O failure is the capture device, not the publisher pipe."""
    lower = (text or "").lower()
    return any(
        token in lower
        for token in (
            "avfoundation",
            "v4l2",
            "shared webcam",
            "/dev/video",
            "selected framerate",
            "opening input",
        )
    )


def looks_like_closed_pipe_eio(text: str) -> bool:
    """ffmpeg died writing stdout after the publisher closed stdin."""
    lower = (text or "").lower()
    if "input/output error" not in lower and "broken pipe" not in lower:
        return False
    if looks_like_camera_eio(text):
        return False
    return any(
        token in lower
        for token in (
            "pipe:1",
            "broken pipe",
            "error writing",
            "error muxing",
            "error submitting a packet",
            "closed publisher pipe",
        )
    )


def looks_like_moq5_exit(text: str) -> bool:
    lower = (text or "").lower()
    return any(
        token in lower
        for token in (
            "endpoint connect failed",
            "sender attach failed",
            "before webtransport connect",
            "stdin eof before ftyp",
            "moq5 publisher exited",
        )
    )


def combine_ffmpeg_closed_pipe_error(
    ffmpeg_error: str,
    publisher_detail: str,
    *,
    backend: str = "moq5",
    code: Optional[int] = None,
) -> str:
    """Prefer publisher stderr when ffmpeg's only signal is a closed-pipe EIO."""
    detail = (publisher_detail or "").strip()
    if detail:
        return publisher_exit_error(backend, code, detail)
    ffmpeg_bit = (ffmpeg_error or "").strip() or "[Errno 5] Input/output error"
    return f"ffmpeg I/O error: {ffmpeg_bit}. {PIPE_EIO_HINT}"


def classify_spawn_oserror(
    exc: BaseException,
    *,
    role: str,
    binary: str = "",
    media_path: str = "",
    relay_url: str = "",
) -> str:
    """Human error for OSError from Popen of publisher / ffmpeg / tee / camera.

    Bare ``[Errno 5] Input/output error`` used to leak to the job as-is
    (agent ``str(exc)``, job_manager ``str(exc)``, classify role=job).
    Distinguish a missing moq5 binary, a camera exclusive-open failure,
    a publisher exec failure, and ffmpeg writing to a closed pipe.
    """
    err_no = getattr(exc, "errno", None)
    text = str(exc)
    is_eio = err_no == errno.EIO or "input/output error" in text.lower()
    is_missing = isinstance(exc, FileNotFoundError) or err_no == errno.ENOENT
    webcam = is_device_webcam_source(media_path) or role == "camera"

    if role in {"publisher", "moq5"}:
        name = os.path.basename(binary) if binary else "moq5-fmp4-publish"
        if is_missing or not binary:
            if "moq5" in name or role == "moq5" or not binary:
                missing = MOQ5_MISSING_HINT
            else:
                missing = f"{name} not found. {MOQ5_MISSING_HINT}"
            return _with_moq_spawn_context(missing, binary=binary, relay_url=relay_url)
        return _with_moq_spawn_context(
            f"Failed to start MoQ publisher {binary}: {text}",
            binary=binary,
            relay_url=relay_url,
        )

    if role == "camera" or looks_like_camera_eio(text):
        if is_eio or role == "camera":
            return f"camera I/O error: {text}. {CAMERA_EIO_HINT}"

    if role in {"ffmpeg", "camera"}:
        if is_missing:
            return f"ffmpeg not found ({binary or 'ffmpeg'}): {text}"
        if is_eio:
            return f"ffmpeg I/O error: {text}. {PIPE_EIO_HINT}"
        return f"Failed to start ffmpeg ({binary}): {text}"

    if role == "tee":
        if is_missing:
            return f"tee not found for MoQ capture: {text}"
        if is_eio:
            return f"MoQ capture tee I/O error: {text}. {PIPE_EIO_HINT}"
        return f"Failed to start MoQ capture tee: {text}"

    if is_eio:
        # After the webcam broker, job ffmpeg reads UDP and writes pipe:1.
        # Bare EIO on device:webcam without avfoundation tokens is that pipe.
        if webcam and looks_like_camera_eio(text):
            return f"camera I/O error: {text}. {CAMERA_EIO_HINT}"
        return f"publish I/O error: {text}. {PIPE_EIO_HINT}"
    return text


def classify_job_exception(
    exc: BaseException,
    *,
    media_path: str = "",
    role: str = "",
    binary: str = "",
    relay_url: str = "",
) -> str:
    """Classify any job-thread exception so last_error is never a bare errno 5."""
    text = str(exc).strip() or type(exc).__name__
    lower = text.lower()
    if (
        lower.startswith("camera i/o error")
        or lower.startswith("failed to start moq publisher")
        or lower.startswith("publish i/o error")
        or lower.startswith("ffmpeg i/o error")
        or lower.startswith("obs websocket")
        or lower.startswith("obs startstream")
        or lower.startswith("obs openmoq")
    ):
        return text
    if "shared webcam capture" in lower and "input/output error" in lower:
        return f"camera I/O error: {text}. {CAMERA_EIO_HINT}"
    if looks_like_camera_eio(text) and "input/output error" in lower:
        return f"camera I/O error: {text}. {CAMERA_EIO_HINT}"
    if is_obs_openmoq_source(media_path) or role == "obs":
        if is_bare_eio_message(text) or "input/output error" in lower:
            return (
                f"OBS WebSocket I/O error ({text}). Check Tools → WebSocket Server "
                "and that OBS is still running."
            )
        return f"OBS OpenMOQ encode failed: {text}."

    if role:
        inferred = role
    elif looks_like_camera_eio(text):
        inferred = "camera"
    elif looks_like_moq5_exit(text):
        inferred = "moq5"
    elif is_device_webcam_source(media_path) or media_path.startswith("udp://"):
        # Webcam broker already holds the camera; job-thread EIO is the pipe.
        inferred = "ffmpeg"
    else:
        inferred = "job"
    if isinstance(exc, OSError):
        return classify_spawn_oserror(
            exc,
            role=inferred,
            binary=binary,
            media_path=media_path,
            relay_url=relay_url,
        )
    if is_bare_eio_message(text) or getattr(exc, "errno", None) == errno.EIO:
        return classify_spawn_oserror(
            OSError(errno.EIO, "Input/output error"),
            role=inferred,
            binary=binary,
            media_path=media_path,
            relay_url=relay_url,
        )
    return text


def classify_result_error(
    error: str,
    *,
    media_path: str = "",
    original_media: str = "",
    publisher_detail: str = "",
    backend: str = "moq5",
    code: Optional[int] = None,
) -> str:
    """Split a job result error into camera vs pipe vs moq5 exit. Never both."""
    text = (error or "").strip()
    if not text:
        return text
    lower = text.lower()
    if (
        lower.startswith("camera i/o error")
        or lower.startswith("ffmpeg i/o error")
        or lower.startswith("publish i/o error")
        or lower.startswith("failed to start moq publisher")
        or lower.startswith("moq5 publisher")
        or lower.startswith("openmoq publisher")
    ):
        return text
    if looks_like_camera_eio(text) or (
        "shared webcam capture" in lower and "input/output error" in lower
    ):
        return f"camera I/O error: {text}. {CAMERA_EIO_HINT}"
    detail = (publisher_detail or "").strip()
    if looks_like_moq5_exit(text) or looks_like_moq5_exit(detail):
        return publisher_exit_error(backend, code, detail or text)
    if (
        looks_like_closed_pipe_eio(text)
        or is_bare_eio_message(text)
        or "input/output error" in lower
    ):
        if detail:
            return combine_ffmpeg_closed_pipe_error(text, detail, backend=backend, code=code)
        return f"ffmpeg I/O error: {text}. {PIPE_EIO_HINT}"
    return text


# Force moq5-fmp4-publish on draft-18 canaries only. Prod :4433 presets
# stay on auto/openmoq so main is unchanged.
MOQ5_FORCED_PRESET_IDS = frozenset(
    {
        "moq_gcp_relay_d18",
        "moq_gcp_east_relay_d18",
        "moq_linode_relay_d18",
    }
)


def resolve_moq_publisher_backend() -> str:
    backend = os.environ.get("MOQ_PUBLISHER_BACKEND", DEFAULT_MOQ_PUBLISHER_BACKEND).strip().lower()
    if backend not in {"auto", "moq5", "openmoq"}:
        raise ValueError(
            f"Invalid MOQ_PUBLISHER_BACKEND '{backend}'. Expected auto, moq5, or openmoq."
        )
    return backend


def moq_publisher_backend_for_preset(
    preset_id: str = "",
    *,
    url: str = "",
    draft: Optional[int] = None,
) -> str:
    """Return publisher backend, forcing moq5 on draft-18 canaries.

    Prod :4433 stays auto/openmoq. A lost preset_id must not fall back to
    openmoq-publisher just because the URL still says draft=18 / :14433.
    """
    if (preset_id or "").strip() in MOQ5_FORCED_PRESET_IDS:
        return "moq5"
    haystack = f"{preset_id} {url}"
    # Prod :4433 URLs omit draft= and must stay openmoq. Parsed draft defaults
    # to 18, so do not key off `draft == 18` alone.
    if ":14433" in haystack or "draft=18" in (url or ""):
        return "moq5"
    return resolve_moq_publisher_backend()


def find_moq_publisher(
    preset_id: str = "",
    *,
    url: str = "",
    draft: Optional[int] = None,
) -> tuple[Optional[str], str]:
    """Return (binary_path, backend_name)."""
    backend = moq_publisher_backend_for_preset(preset_id, url=url, draft=draft)
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


def moq_insecure_tls_for_endpoint(endpoint: str, requested: bool = False) -> bool:
    """sslip.io relays use public names with private certs — always skip verify.

    Helper jobs reconstruct ``MoqPublishTarget`` from JSON. A missing or
    false ``insecure_tls`` used to omit ``--insecure-skip-verify`` and
    WebTransport never connected from the laptop even though cloud encode
    (which goes through parse_moq_publish_url) succeeded.
    """
    if requested:
        return True
    host = (urlparse((endpoint or "").strip()).hostname or "").lower()
    return host.endswith(".sslip.io") or os.environ.get("MOQ_PUBLISHER_INSECURE", "") == "1"


def infer_moq_draft_from_url(url: str) -> int:
    """Draft for a URL that omitted ``?draft=``.

    Prod ``:4433`` is draft-16 only. Defaulting those URLs to
    ``DEFAULT_MOQ_DRAFT`` (18) made openmoq-publisher offer moqt-18 against
    ``ghcr.io/openmoq/moqx:329b98b`` and WebTransport never connected.
    """
    parsed = urlparse((url or "").strip())
    netloc = parsed.netloc or ""
    if parsed.port == 4433 or ":4433" in netloc:
        return 16
    if parsed.port == 14433 or ":14433" in netloc:
        return 18
    return DEFAULT_MOQ_DRAFT


def describe_moq_connect_failure(
    *,
    endpoint: str,
    backend: str,
    binary: str,
    draft: int,
) -> str:
    """Job error when the publisher process ran but WT never connected."""
    loc = f"relay={endpoint} binary={binary or backend} draft={draft}"
    if ":4433" in (endpoint or ""):
        if backend == "moq5" or "moq5-fmp4-publish" in (binary or ""):
            return (
                "The publisher ran but did not connect to the relay "
                f"(WebTransport session never connected; no connection_id). {loc}. "
                "moq5-fmp4-publish offered draft-18 to prod :4433, which only "
                "forwards draft-16 (ghcr.io/openmoq/moqx:329b98b). Pick "
                "OpenMOQ draft-18 canary · GCP us-central1 (:14433) — do not "
                "point draft-18 traffic at prod :4433."
            )
        return (
            "The publisher ran but did not connect to the relay "
            f"(WebTransport session never connected; no connection_id). {loc}. "
            "openmoq-publisher never got a WebTransport session on prod :4433 "
            "(draft-16 only). This is not a player or catalog problem."
        )
    return (
        "The publisher ran but did not connect to the relay "
        f"(WebTransport session never connected; no connection_id). {loc}."
    )


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
    if query.get("draft"):
        draft_raw = query["draft"][0]
        try:
            draft = int(draft_raw)
        except ValueError as exc:
            raise ValueError(f"Invalid MOQ draft query parameter: {draft_raw}") from exc
    else:
        draft = infer_moq_draft_from_url(url)

    forward_raw = (query.get("forward") or [str(DEFAULT_MOQ_FORWARD)])[0]
    try:
        forward = int(forward_raw)
    except ValueError as exc:
        raise ValueError(f"Invalid MOQ forward query parameter: {forward_raw}") from exc

    insecure_tls = moq_insecure_tls_for_endpoint(endpoint)

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
# OBS Studio encodes; OpenMOQ plugin + OBS SRT/RTMP outputs publish.
OBS_OPENMOQ_MEDIA = "obs:openmoq"


def is_device_webcam_source(media_path: str) -> bool:
    value = (media_path or "").strip().lower()
    return value == DEVICE_WEBCAM_MEDIA or value.startswith("device:webcam")


def is_device_browser_source(media_path: str) -> bool:
    value = (media_path or "").strip().lower()
    return value == DEVICE_BROWSER_MEDIA or value.startswith("device:browser")


def is_obs_openmoq_source(media_path: str) -> bool:
    value = (media_path or "").strip().lower()
    return value == OBS_OPENMOQ_MEDIA or value.startswith("obs:openmoq")


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
    ) or is_device_browser_source(media_path) or is_obs_openmoq_source(media_path)


SHARED_ENCODE_QUERY = "shared_encode=1"


def is_brokered_webcam_udp(media_path: str) -> bool:
    """Local publisher already encoded this hop (webcam broker → loopback MPEG-TS)."""
    value = (media_path or "").strip().lower()
    return value.startswith("udp://") and SHARED_ENCODE_QUERY not in value


def is_shared_encode_udp(media_path: str) -> bool:
    """Comparison hub already encoded this hop (one x264 → loopback MPEG-TS)."""
    value = (media_path or "").strip().lower()
    return value.startswith("udp://") and SHARED_ENCODE_QUERY in value


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
        # Prefer a real advertised mode (same defaults as the broker).
        # Do not leave size unset — Macs then pick portrait 1080x1920 at
        # 1000k tbr and speed oscillates. Encode ladder still scales.
        return build_device_webcam_input_args(
            duration_sec=duration_sec,
            device_index=device_webcam_index(media_path),
            video_size=PREFERRED_SIZE,
            framerate=str(int(PREFERRED_FPS)),
        )
    if is_live_media_source(media_path):
        # Copy remux must keep the broker's DTS. wallclock+genpts+igndts on a
        # second encode made catch-up bursts look like timeline holes.
        if is_shared_encode_udp(media_path) or is_brokered_webcam_udp(media_path):
            # Copy → fMP4 needs SPS (width/height) before write_header.
            # 32k / analyzeduration 0 sees "Video: h264, none" and the mp4
            # muxer exits 234: "dimensions not set". Broker GOP is 1s with
            # repeat-headers=1; wait one IDR, not a second encode.
            return [
                "-fflags",
                "+nobuffer+discardcorrupt",
                "-flags",
                "low_delay",
                "-f",
                "mpegts",
                "-probesize",
                "2M",
                "-analyzeduration",
                "2000000",
                "-i",
                media_path,
            ]
        # Other live URLs (SRT/RTSP) still regenerate PTS for a second encode.
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
    #
    # Webcam UDP is already H.264 from the broker. A second x264 (even
    # ultrafast) still ran at 24↔37 fps / 0.84↔1.28× while the RTMP sibling
    # held 30/0.99 (comparison CSV 2026-08-21). Remux copy; groups follow
    # the master's 1s IDRs.
    if is_shared_encode_udp(media_path) or is_brokered_webcam_udp(media_path):
        # Video copy. Audio must be re-encoded: empty_moov writes the
        # header before the first ADTS packet, so -c:a copy leaves no
        # AudioSpecificConfig and moq5 fails "CMAF track 1" (job 7037dc27).
        video_args = ["-c:v", "copy"]
        audio_args = list(BROWSER_COMPAT_AUDIO_ARGS)
    elif is_device_webcam_source(media_path):
        # Solo webcam (broker skipped): one encode at the MoQ GOP (~0.25s).
        # Mixed siblings keep the 1s master and copy it — do not drop that
        # GOP for SRT/RTMP (known 24 fps / 0.8×).
        video_args = build_video_encode_args(
            encode_ladder,
            target_latency_ms,
            gop_frames=moq_gop_frames_for_latency(target_latency_ms),
            preset="ultrafast",
            output_cfr=False,
            rebase_pts=True,
        )
        audio_args = [
            *BROWSER_COMPAT_AUDIO_ARGS,
            "-af",
            "asetpts=PTS-STARTPTS",
        ]
    else:
        wallclock_pts = is_live_media_source(media_path) and not is_device_webcam_source(
            media_path
        )
        video_args = build_video_encode_args(
            encode_ladder,
            target_latency_ms,
            gop_frames=moq_gop_frames_for_latency(target_latency_ms),
            wallclock_pts=wallclock_pts,
        )
        audio_args = list(BROWSER_COMPAT_AUDIO_ARGS)
    return [
        find_ffmpeg(),
        "-y",
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
        *audio_args,
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
        *(
            ["--insecure-skip-verify"]
            if moq_insecure_tls_for_endpoint(target.endpoint, target.insecure_tls)
            else []
        ),
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


def publisher_first_object_sent(log_text: str) -> bool:
    """True when the publisher logged a successful first media object.

    ``live: sent track=`` is older moq5 / openmoq first-group write (MOQ_OK).
    Current moq5 logs ``obj vide wall_dt_ms=``. CONNECT / ``connection_id=``
    alone is not publish success.
    """
    text = log_text or ""
    return (
        "live: sent track=" in text
        or "MOQ_OK" in text
        or "obj vide wall_dt_ms=" in text
    )


def publisher_catalog_published(log_text: str) -> bool:
    """True when the first live catalog already has vide (not CONNECT alone).

    Linode canary admin :18000 is not public, so the moqx poller cannot
    confirm announce. ``sender ready`` / attach-after-moov is the local
    proof the retained catalog is fetchable. ``live: sent`` without that
    is the old attach-before-moov binary (empty group-0 catalog).
    """
    text = log_text or ""
    if "sender ready (namespace + catalog published)" in text:
        return True
    return (
        "attaching sender after CMAF init" in text
        and "track added: vide" in text
        and ("obj vide wall_dt_ms=" in text or "live: sent track=vide" in text)
    )


def publisher_webtransport_connected(log_text: str) -> bool:
    """True when openmoq-publisher logged a live WebTransport session.

    ``connection_id=wt-…`` goes to stdout (libc-block-buffered inside Docker,
    so it may land in the drain file only after exit). ``live: sent track=``
    on stderr is the same fact: objects already went out on that session.
    bench-216482ff had both, and the waiter still called it "before CONNECT"
    because it only looked for ``connection_id=`` in a prefix of stdout.
    """
    text = log_text or ""
    return "connection_id=" in text or "live: sent track=" in text or "track added:" in text


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
        *(
            ["--insecure"]
            if moq_insecure_tls_for_endpoint(target.endpoint, target.insecure_tls)
            else []
        ),
    ]
    if paced:
        cmd.append("--paced")
    return cmd
