import logging
import os
import shutil
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
        "https://127.0.0.1:14433/moq-relay",
    ).strip()


def _recorder_tracks(video_track: str) -> list[str]:
    requested = (video_track or "").strip()
    if requested:
        return [requested]
    # Browser LOC advertises `video`; cloud openmoq advertises CMAF `vide_1`.
    return ["video", "vide_1"]


def recording_has_media(path: Path, min_bytes: int = 256) -> bool:
    """True when the recorder wrote enough bytes to score, regardless of exit code."""
    try:
        return path.is_file() and path.stat().st_size >= min_bytes
    except OSError:
        return False


def _docker_record_cmd(
    *,
    relay: str,
    namespace: str,
    output_path: Path,
    duration_sec: int,
    tracks: list[str],
    cert_sha256: str,
) -> Optional[list[str]]:
    """Run the image with host record.mjs bind-mounted.

    The baked image still has the CMAF-only recorder; bind-mounting is how we
    pick up loc `video` without a multi-minute docker rebuild.
    """
    if not shutil.which("docker"):
        return None
    recorder_bin = Path(_resolve_recorder_bin()).resolve()
    recorder_dir = recorder_bin.parent.parent
    record_js = recorder_dir / "record.mjs"
    cert_js = recorder_dir / "cert.mjs"
    if not record_js.is_file():
        return None
    image = os.environ.get("MOQ_RECORDER_IMAGE", "openmoq-recorder:latest")
    cmd = [
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "-e",
        f"MOQ_RELAY_CERT_SHA256={cert_sha256.strip()}",
        "-v",
        f"{output_path.parent}:/out",
        "-v",
        f"{record_js}:/app/tools/openmoq-recorder/record.mjs:ro",
    ]
    if cert_js.is_file():
        cmd.extend(["-v", f"{cert_js}:/app/tools/openmoq-recorder/cert.mjs:ro"])
    cmd.extend([
        image,
        relay,
        namespace,
        f"/out/{output_path.name}",
        "--duration",
        str(duration_sec),
    ])
    for track in tracks:
        cmd.extend(["--track", track])
    return cmd


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
    cert_sha256: str = "",
    video_track: str = "",
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
    tracks = _recorder_tracks(video_track)
    pin = (cert_sha256 or "").strip()
    cmd = _docker_record_cmd(
        relay=relay,
        namespace=namespace.strip(),
        output_path=output_path,
        duration_sec=record_duration,
        tracks=tracks,
        cert_sha256=pin,
    )
    if cmd is None:
        cmd = [
            recorder,
            relay,
            namespace.strip(),
            str(output_path),
            "--duration",
            str(record_duration),
        ]
        for track in tracks:
            cmd.extend(["--track", track])

    with _lock:
        existing = _recordings.get(job_id)
        if existing and existing.status == "recording":
            return existing

    logger.info(
        "Starting MoQ recording job=%s namespace=%s tracks=%s recorder=%s output=%s",
        job_id,
        namespace,
        ",".join(tracks),
        cmd[0],
        output_path,
    )
    try:
        env = os.environ.copy()
        env["MOQ_RECORDER_IMAGE"] = os.environ.get("MOQ_RECORDER_IMAGE", "openmoq-recorder:latest")
        # A stale catch-all pin in the agent env used to override hostname
        # lookup and break east/Linode recordings. Only pin when this job
        # supplied a hash for *its* relay.
        pin = (cert_sha256 or "").strip()
        if pin:
            env["MOQ_RELAY_CERT_SHA256"] = pin
        else:
            env.pop("MOQ_RELAY_CERT_SHA256", None)
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            env=env,
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
        with _lock:
            current = _recordings.get(job_id)
            if current is None:
                return
            if recording_has_media(output_path):
                # SIGTERM from stop_moq_recording and Resetstream both exit
                # non-zero; the annex-b dump is what VMAF needs.
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
            if recording_has_media(output):
                state.status = "completed"
                state.error = ""
            else:
                state.status = "failed"
                state.error = state.error or "Recording stopped before output was written"
        state.pid = None
        _processes.pop(job_id, None)
        return state


def get_recording_state(job_id: str) -> Optional[RecordingState]:
    with _lock:
        return _recordings.get(job_id)
