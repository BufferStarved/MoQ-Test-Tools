import logging
import shutil
import subprocess
from typing import List, Optional, Tuple

logger = logging.getLogger("MoQ-SRT-Bench")


def _ffmpeg_bin() -> str:
    preferred = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
    if shutil.which(preferred):
        return preferred
    found = shutil.which("ffmpeg")
    if found:
        return found
    return "ffmpeg"


def probe_http_ts_push_endpoint(
    url: str,
    media_path: str,
    duration_sec: float = 2.0,
) -> Tuple[bool, str]:
    """
    Run a short ffmpeg MPEG-TS over HTTP push to verify Zixi accepts the ingest.
    """
    cmd: List[str] = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-i",
        media_path,
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-t",
        str(duration_sec),
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
    media_path: str,
    duration_sec: float = 2.0,
) -> Tuple[bool, str]:
    """
    Run a short ffmpeg RTMP publish to verify the ingest endpoint accepts connections.
    """
    cmd: List[str] = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-i",
        media_path,
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-t",
        str(duration_sec),
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
) -> Tuple[bool, str]:
    if protocol == "rtmp":
        return probe_rtmp_endpoint(url, media_path)
    if protocol in {"hls", "dash"}:
        return probe_http_ts_push_endpoint(url, media_path)
    return True, ""
