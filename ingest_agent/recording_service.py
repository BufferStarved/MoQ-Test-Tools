import logging
import os
import signal
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from config import RECORDING_DIR

logger = logging.getLogger("ingest-agent")


@dataclass
class RecordingState:
    job_id: str
    output_path: str
    namespace: str
    relay_url: str
    status: str = "recording"
    error: str = ""
    pid: Optional[int] = None


_lock = threading.Lock()
_recordings: dict[str, RecordingState] = {}
_processes: dict[str, subprocess.Popen] = {}


def _resolve_recorder_bin() -> str:
    return os.environ.get(
        "MOQ_RECORDER_BIN",
        "/opt/moq-test-tools/tools/openmoq-recorder/bin/openmoq-fmp4-record",
    )


def _resolve_relay_url(explicit: str = "") -> str:
    if explicit.strip():
        return explicit.strip()
    return os.environ.get(
        "MOQ_RELAY_URL",
        "https://127.0.0.1:4433/moq-relay",
    ).strip()


def recording_output_path(job_id: str, recording_dir: str = "") -> Path:
    root = Path(recording_dir or RECORDING_DIR)
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{job_id}.mp4"


def start_moq_recording(
    job_id: str,
    *,
    namespace: str,
    duration_sec: int,
    relay_url: str = "",
    recording_dir: str = "",
) -> RecordingState:
    if not namespace.strip():
        raise ValueError("namespace is required")

    recorder = _resolve_recorder_bin()
    if not os.path.isfile(recorder) or not os.access(recorder, os.X_OK):
        raise RuntimeError(
            f"MoQ recorder not found at {recorder}. "
            "Run sudo bash infra/zixi/scripts/install-openmoq-recorder.sh on the ingest worker."
        )

    output_path = recording_output_path(job_id, recording_dir=recording_dir)
    if output_path.exists():
        output_path.unlink()

    relay = _resolve_relay_url(relay_url)
    record_duration = max(duration_sec + 20, 60)
    cmd = [
        recorder,
        relay,
        namespace.strip(),
        str(output_path),
        "--duration",
        str(record_duration),
    ]

    with _lock:
        existing = _recordings.get(job_id)
        if existing and existing.status == "recording":
            return existing

    logger.info(
        "Starting MoQ recording job=%s namespace=%s output=%s",
        job_id,
        namespace,
        output_path,
    )
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            env={
                **os.environ,
                "MOQ_RELAY_CERT_SHA256": os.environ.get("MOQ_RELAY_CERT_SHA256", ""),
                "MOQ_RECORDER_IMAGE": os.environ.get("MOQ_RECORDER_IMAGE", "openmoq-recorder:latest"),
            },
        )
    except OSError as exc:
        raise RuntimeError(f"Could not start MoQ recorder: {exc}") from exc

    state = RecordingState(
        job_id=job_id,
        output_path=str(output_path),
        namespace=namespace.strip(),
        relay_url=relay,
        status="recording",
        pid=proc.pid,
    )

    with _lock:
        _recordings[job_id] = state
        _processes[job_id] = proc

    def _watch() -> None:
        try:
            _, stderr = proc.communicate(timeout=record_duration + 120)
        except subprocess.TimeoutExpired:
            proc.kill()
            _, stderr = proc.communicate()
        exit_code = proc.returncode
        output_ok = output_path.is_file() and output_path.stat().st_size > 0
        with _lock:
            current = _recordings.get(job_id)
            if current is None:
                return
            if exit_code == 0 and output_ok:
                current.status = "completed"
                current.error = ""
            else:
                detail = (stderr or b"").decode("utf-8", errors="replace").strip()
                # Keep the end of the log — early "retrying" lines hid the real failure.
                if len(detail) > 500:
                    detail = detail[-500:]
                current.status = "failed"
                current.error = detail or f"recorder exited with code {exit_code}"
            current.pid = None
            _processes.pop(job_id, None)
        logger.info(
            "MoQ recording finished job=%s status=%s size=%s",
            job_id,
            _recordings[job_id].status,
            output_path.stat().st_size if output_path.exists() else 0,
        )

    threading.Thread(target=_watch, daemon=True).start()
    return state


def stop_moq_recording(job_id: str) -> RecordingState:
    with _lock:
        state = _recordings.get(job_id)
        proc = _processes.get(job_id)

    if state is None:
        raise KeyError(f"No recording for job {job_id}")

    if proc is not None and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()

    with _lock:
        state = _recordings.get(job_id)
        if state is None:
            raise KeyError(f"No recording for job {job_id}")
        if state.status == "recording":
            output = Path(state.output_path)
            if output.is_file() and output.stat().st_size > 0:
                state.status = "completed"
            else:
                state.status = "failed"
                state.error = state.error or "Recording stopped before output was written"
        state.pid = None
        _processes.pop(job_id, None)
        return state


def get_recording_state(job_id: str) -> Optional[RecordingState]:
    with _lock:
        return _recordings.get(job_id)
