import logging
import shutil
import socket
import subprocess
from typing import List, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger("MoQ-SRT-Bench")

# Short synthetic publish — never consume the job's live UDP/webcam bridge.
# 0.5s is enough to confirm the RTMP/HTTP-TS listener accepts a session;
# the old 2.0s realtime probe sat on the critical path before every encode.
DEFAULT_PREFLIGHT_DURATION_SEC = 0.5


def _ffmpeg_bin() -> str:
    preferred = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
    if shutil.which(preferred):
        return preferred
    found = shutil.which("ffmpeg")
    if found:
        return found
    return "ffmpeg"


def _tcp_connect_ok(url: str, *, default_port: int, timeout_sec: float = 1.5) -> Tuple[bool, str]:
    """Fast reachability check — no media, no ffmpeg."""
    try:
        parsed = urlparse(url)
    except ValueError as exc:
        return False, f"Invalid URL: {exc}"
    host = (parsed.hostname or "").strip()
    if not host:
        return False, "URL has no host"
    port = parsed.port or default_port
    try:
        with socket.create_connection((host, port), timeout=timeout_sec):
            return True, ""
    except OSError as exc:
        return False, f"TCP connect to {host}:{port} failed: {exc}"


def _synthetic_av_input_args(duration_sec: float) -> List[str]:
    """lavfi color bars + tone — never reads the job media_path / live bridge."""
    return [
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=320x180:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-t",
        str(duration_sec),
        "-shortest",
    ]


def probe_http_ts_push_endpoint(
    url: str,
    media_path: str = "",
    duration_sec: float = DEFAULT_PREFLIGHT_DURATION_SEC,
) -> Tuple[bool, str]:
    """
    Short ffmpeg MPEG-TS over HTTP push with synthetic A/V.

    ``media_path`` is ignored (kept for call-site compatibility). Live webcam
    bridges must not be drained by a preflight.
    """
    del media_path  # intentional — never consume job media
    cmd: List[str] = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-loglevel",
        "error",
        *_synthetic_av_input_args(duration_sec),
        "-f",
        "mpegts",
        "-method",
        "PUT",
        url,
    ]

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=max(15, int(duration_sec) + 10),
            check=False,
        )
    except FileNotFoundError:
        return False, "ffmpeg not found in PATH"
    except subprocess.TimeoutExpired:
        return False, "HTTP TS push preflight timed out before ffmpeg finished"

    if completed.returncode == 0:
        return True, ""

    stderr = (completed.stderr or "").strip()
    detail = stderr.splitlines()[-1] if stderr else "unknown ffmpeg error"
    hint = (
        " For Zixi HTTP TS push, enable the HTTP server on port 7777, "
        "turn on Allow Automatic HTTP Push input (or add an HTTP_PUSH input "
        "with matching Stream ID), and run "
        "infra/zixi/scripts/configure-zixi-hls-dash-output.sh on the ingest host."
    )
    return False, f"HTTP TS push preflight failed: {detail}.{hint}"


def probe_rtmp_endpoint(
    url: str,
    media_path: str = "",
    duration_sec: float = DEFAULT_PREFLIGHT_DURATION_SEC,
    *,
    skip_publish: bool = False,
) -> Tuple[bool, str]:
    """
    Verify RTMP ingest without consuming the job media / live bridge.

    - Always starts with a TCP connect to the RTMP port (ms).
    - Optionally follows with a short lavfi→FLV publish (default 0.5s).
    - ``skip_publish=True`` (managed Zixi): TCP only — early-exit retry on the
      real encode covers input-recreate races; saves ~0.5–2s on every join.
    """
    del media_path  # intentional — never consume job media
    ok, err = _tcp_connect_ok(url, default_port=1935)
    if not ok:
        hint = (
            " For Zixi RTMP push, confirm RTMP server is enabled on port 1935 "
            "and run infra/zixi/scripts/configure-zixi-rtmp-input.sh."
        )
        return False, f"RTMP preflight failed: {err}.{hint}"
    if skip_publish:
        logger.info("RTMP preflight: TCP ok, skipping lavfi publish (managed ingest)")
        return True, ""

    cmd: List[str] = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-loglevel",
        "error",
        *_synthetic_av_input_args(duration_sec),
        "-f",
        "flv",
        "-flvflags",
        "no_duration_filesize",
        url,
    ]

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=max(15, int(duration_sec) + 10),
            check=False,
        )
    except FileNotFoundError:
        return False, "ffmpeg not found in PATH"
    except subprocess.TimeoutExpired:
        return False, "RTMP preflight timed out before ffmpeg finished"

    if completed.returncode == 0:
        return True, ""

    stderr = (completed.stderr or "").strip()
    detail = stderr.splitlines()[-1] if stderr else "unknown ffmpeg error"
    hint = (
        " For Zixi RTMP push, confirm RTMP server is enabled on port 1935, "
        "the push input Stream ID matches the URL stream key (e.g. benchmark for "
        "rtmp://host:1935/live/benchmark), and run "
        "infra/zixi/scripts/configure-zixi-rtmp-input.sh on the ingest host."
    )
    return False, f"RTMP preflight failed: {detail}.{hint}"


def probe_endpoint(
    protocol: str,
    url: str,
    media_path: str,
    *,
    ingest_provider: str = "",
) -> Tuple[bool, str]:
    provider = (ingest_provider or "").strip().lower()
    if protocol == "rtmp":
        # Managed Zixi: TCP-only. Full lavfi publish used to cost ~2s of realtime
        # and drained live UDP when media_path pointed at the webcam bridge.
        skip_publish = provider.endswith("_zixi") or provider == "gcp_zixi"
        return probe_rtmp_endpoint(url, media_path, skip_publish=skip_publish)
    if protocol in {"hls", "dash"}:
        return probe_http_ts_push_endpoint(url, media_path)
    return True, ""
