"""During-job HTTP-TS capture for Zixi ingest VMAF.

Post-job pulls of ``/<stream>.ts`` return empty HTTP 200 once the publisher
stops, so VMAF sat on "computing" and never scored. Capture while the
push is live and write ``http-ts-capture.ts`` into the job work dir.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from config import FFMPEG_BIN
from vmaf_service import job_dir

logger = logging.getLogger("ingest-agent")

_MIN_TS_BYTES = 188


@dataclass
class TsCaptureState:
    job_id: str
    url: str
    output_path: str
    status: str = "recording"
    error: str = ""
    pid: Optional[int] = None


_lock = threading.Lock()
_captures: dict[str, TsCaptureState] = {}
_processes: dict[str, subprocess.Popen] = {}


def http_ts_capture_path(job_id: str) -> Path:
    return job_dir(job_id) / "http-ts-capture.ts"


def capture_has_media(path: Path, min_bytes: int = _MIN_TS_BYTES) -> bool:
    try:
        return path.is_file() and path.stat().st_size >= min_bytes
    except OSError:
        return False


def get_http_ts_capture_path(job_id: str) -> Optional[str]:
    path = http_ts_capture_path(job_id)
    if capture_has_media(path):
        return str(path)
    return None


def _resolve_ffmpeg() -> str:
    for candidate in (FFMPEG_BIN, "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "ffmpeg"):
        if candidate and (os.path.isfile(candidate) or candidate == "ffmpeg"):
            return candidate
    return "ffmpeg"


def start_http_ts_capture(
    job_id: str,
    *,
    url: str,
    duration_sec: int,
) -> TsCaptureState:
    source = (url or "").strip()
    if not source:
        raise ValueError("http_ts_url is required")

    dest = http_ts_capture_path(job_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()

    record_duration = max(int(duration_sec) + 8, 12)
    cmd = [
        _resolve_ffmpeg(),
        "-hide_banner",
        "-loglevel",
        "error",
        "-rw_timeout",
        "15000000",
        "-y",
        "-i",
        source,
        "-t",
        str(record_duration),
        "-c",
        "copy",
        str(dest),
    ]

    with _lock:
        existing = _captures.get(job_id)
        if existing and existing.status == "recording":
            return existing

    logger.info("Starting HTTP-TS capture job=%s url=%s output=%s", job_id, source, dest)
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError as exc:
        raise RuntimeError(f"Could not start HTTP-TS capture: {exc}") from exc

    state = TsCaptureState(
        job_id=job_id,
        url=source,
        output_path=str(dest),
        status="recording",
        pid=proc.pid,
    )
    with _lock:
        _captures[job_id] = state
        _processes[job_id] = proc

    def _watch() -> None:
        try:
            _, stderr = proc.communicate(timeout=record_duration + 30)
        except subprocess.TimeoutExpired:
            proc.kill()
            _, stderr = proc.communicate()
        with _lock:
            current = _captures.get(job_id)
            if current is None:
                return
            if capture_has_media(dest):
                current.status = "completed"
                current.error = ""
            else:
                detail = (stderr or b"").decode("utf-8", errors="replace").strip()
                if len(detail) > 400:
                    detail = detail[-400:]
                current.status = "failed"
                current.error = detail or f"HTTP-TS capture exited with code {proc.returncode}"
            current.pid = None
            _processes.pop(job_id, None)

    threading.Thread(target=_watch, daemon=True, name=f"http-ts-capture-{job_id[:8]}").start()
    return state


def stop_http_ts_capture(job_id: str) -> TsCaptureState:
    with _lock:
        state = _captures.get(job_id)
        proc = _processes.get(job_id)
    if state is None:
        path = http_ts_capture_path(job_id)
        if capture_has_media(path):
            return TsCaptureState(
                job_id=job_id,
                url="",
                output_path=str(path),
                status="completed",
            )
        raise KeyError(f"No HTTP-TS capture for job {job_id}")

    if proc is not None and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    with _lock:
        state = _captures.get(job_id)
        if state is None:
            raise KeyError(f"No HTTP-TS capture for job {job_id}")
        if state.status == "recording":
            output = Path(state.output_path)
            if capture_has_media(output):
                state.status = "completed"
                state.error = ""
            else:
                state.status = "failed"
                state.error = state.error or "HTTP-TS capture stopped before media was written"
        state.pid = None
        _processes.pop(job_id, None)
        return state


def get_http_ts_capture_state(job_id: str) -> Optional[TsCaptureState]:
    with _lock:
        return _captures.get(job_id)
