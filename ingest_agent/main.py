import logging
import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from config import API_TOKEN, PORT, RECORDING_DIR, WORK_DIR
from host_metrics import read_host_metrics
from recording_service import RecordingState, get_recording_state, start_moq_recording, stop_moq_recording
from vmaf_service import (
    VmafJobState,
    compute_vmaf,
    job_dir,
    reference_path_for,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ingest-agent")

app = FastAPI(title="MoQ Ingest Agent", version="1.0.0")

_jobs: dict[str, VmafJobState] = {}


def verify_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token != API_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")


class VmafComputeRequest(BaseModel):
    start_epoch: float
    end_epoch: float
    recording_dir: str = ""


class RecordingStartRequest(BaseModel):
    namespace: str
    duration_sec: int = Field(default=60, ge=5, le=3600)
    relay_url: str = ""
    recording_dir: str = ""


class RecordingResponse(BaseModel):
    job_id: str
    status: str
    output_path: str = ""
    namespace: str = ""
    relay_url: str = ""
    error: str = ""
    pid: Optional[int] = None


class JobResponse(BaseModel):
    job_id: str
    status: str
    reference_uploaded: bool = False
    reference_path: str = ""
    vmaf_score: Optional[float] = None
    psnr_db: Optional[float] = None
    ssim: Optional[float] = None
    distorted_path: str = ""
    log_path: str = ""
    error: str = ""
    recording_dir: str = RECORDING_DIR


def _to_response(state: VmafJobState) -> JobResponse:
    return JobResponse(
        job_id=state.job_id,
        status=state.status,
        reference_uploaded=bool(state.reference_path),
        reference_path=state.reference_path,
        vmaf_score=state.vmaf_score,
        psnr_db=state.psnr_db,
        ssim=state.ssim,
        distorted_path=state.distorted_path,
        log_path=state.log_path,
        error=state.error,
    )


@app.on_event("startup")
def startup() -> None:
    os.makedirs(WORK_DIR, exist_ok=True)
    logger.info("Ingest agent started. work_dir=%s recording_dir=%s port=%s", WORK_DIR, RECORDING_DIR, PORT)


def _recording_to_response(state: RecordingState) -> RecordingResponse:
    return RecordingResponse(
        job_id=state.job_id,
        status=state.status,
        output_path=state.output_path,
        namespace=state.namespace,
        relay_url=state.relay_url,
        error=state.error,
        pid=state.pid,
    )


@app.get("/api/v1/health")
def health() -> dict:
    from config import MOQ_RECORDER_BIN, MOQ_RELAY_CERT_SHA256, MOQ_RELAY_URL
    from vmaf_service import _resolve_ffmpeg

    ffmpeg = _resolve_ffmpeg()
    recorder_bin_ok = os.path.isfile(MOQ_RECORDER_BIN) and os.access(MOQ_RECORDER_BIN, os.X_OK)
    recorder_runtime_ok = False
    recorder_runtime_error = ""
    if recorder_bin_ok:
        try:
            probe = subprocess.run(
                [MOQ_RECORDER_BIN, "--probe"],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
            recorder_runtime_ok = probe.returncode == 0
            if not recorder_runtime_ok:
                recorder_runtime_error = (probe.stderr or probe.stdout or "probe failed").strip()[:300]
        except (OSError, subprocess.TimeoutExpired) as exc:
            recorder_runtime_error = str(exc)

    return {
        "status": "ok",
        "service": "moq-ingest-agent",
        "recording_dir": RECORDING_DIR,
        "ffmpeg": ffmpeg or "",
        "libvmaf_available": bool(ffmpeg),
        "moq_recorder_bin": MOQ_RECORDER_BIN,
        "moq_recorder_available": recorder_bin_ok and recorder_runtime_ok,
        "moq_recorder_runtime_ok": recorder_runtime_ok,
        "moq_recorder_runtime_error": recorder_runtime_error,
        "moq_relay_url": MOQ_RELAY_URL,
        "moq_relay_cert_configured": bool(MOQ_RELAY_CERT_SHA256),
    }


@app.post("/api/v1/jobs/{job_id}/reference", dependencies=[Depends(verify_token)])
async def upload_reference(job_id: str, file: UploadFile = File(...)) -> JobResponse:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    suffix = Path(file.filename).suffix or ".mp4"
    target_dir = job_dir(job_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = reference_path_for(job_id, suffix=suffix)

    try:
        with open(target_path, "wb") as handle:
            shutil.copyfileobj(file.file, handle)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not save reference file: {exc}") from exc

    state = VmafJobState(
        job_id=job_id,
        reference_path=str(target_path),
        status="reference_ready",
    )
    _jobs[job_id] = state
    logger.info("Reference uploaded for job %s at %s", job_id, target_path)
    return _to_response(state)


@app.get("/api/v1/host/metrics", dependencies=[Depends(verify_token)])
def host_metrics() -> dict:
    snapshot = read_host_metrics()
    return {
        "cpu_percent": snapshot.cpu_percent,
        "memory_percent": snapshot.memory_percent,
        "disk_percent": snapshot.disk_percent,
    }


@app.post("/api/v1/jobs/{job_id}/recording/start", dependencies=[Depends(verify_token)])
def start_recording(job_id: str, request: RecordingStartRequest) -> RecordingResponse:
    try:
        state = start_moq_recording(
            job_id,
            namespace=request.namespace,
            duration_sec=request.duration_sec,
            relay_url=request.relay_url,
            recording_dir=request.recording_dir,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _recording_to_response(state)


@app.post("/api/v1/jobs/{job_id}/recording/stop", dependencies=[Depends(verify_token)])
def stop_recording(job_id: str) -> RecordingResponse:
    try:
        state = stop_moq_recording(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _recording_to_response(state)


@app.get("/api/v1/jobs/{job_id}/recording", dependencies=[Depends(verify_token)])
def recording_status(job_id: str) -> RecordingResponse:
    state = get_recording_state(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="Recording not found")
    return _recording_to_response(state)


class MediaHealthRequest(BaseModel):
    start_epoch: float = 0.0
    end_epoch: float = 0.0
    recording_dir: str = ""
    output_path: str = ""


@app.post("/api/v1/jobs/{job_id}/media-health", dependencies=[Depends(verify_token)])
def run_media_health(job_id: str, request: MediaHealthRequest) -> dict:
    """Analyze post-relay CMAF/fMP4 recording for Media Health (seq/tfdt gaps)."""
    from cmaf_integrity import analyze_cmaf_file
    from recording_service import get_recording_state, recording_output_path
    from vmaf_service import find_distorted_recording

    path = (request.output_path or "").strip()
    if not path:
        recording = get_recording_state(job_id)
        if recording and recording.output_path:
            path = recording.output_path
        else:
            candidate = recording_output_path(job_id, recording_dir=request.recording_dir)
            if candidate.is_file():
                path = str(candidate)
    if not path and request.start_epoch and request.end_epoch:
        found = find_distorted_recording(
            request.start_epoch,
            request.end_epoch,
            recording_dir=request.recording_dir,
            job_id=job_id,
        )
        if found:
            path = found
    if not path or not Path(path).is_file():
        raise HTTPException(status_code=404, detail="No MoQ recording found for media health")

    report = analyze_cmaf_file(path)
    payload = report.as_summary_dict()
    payload["status"] = "failed" if report.error and report.fragment_count == 0 else "completed"
    payload["job_id"] = job_id
    return payload


@app.post("/api/v1/jobs/{job_id}/vmaf", dependencies=[Depends(verify_token)])
def run_vmaf(job_id: str, request: VmafComputeRequest) -> JobResponse:
    if request.end_epoch < request.start_epoch:
        raise HTTPException(status_code=400, detail="end_epoch must be >= start_epoch")

    state = compute_vmaf(
        job_id=job_id,
        start_epoch=request.start_epoch,
        end_epoch=request.end_epoch,
        recording_dir=request.recording_dir,
    )
    _jobs[job_id] = state
    logger.info("VMAF job %s status=%s score=%s", job_id, state.status, state.vmaf_score)
    return _to_response(state)


@app.get("/api/v1/jobs/{job_id}", dependencies=[Depends(verify_token)])
def get_job(job_id: str) -> JobResponse:
    state = _jobs.get(job_id)
    if state is None:
        reference = None
        for candidate in job_dir(job_id).glob("reference*"):
            if candidate.is_file():
                reference = str(candidate)
                break
        if not reference:
            raise HTTPException(status_code=404, detail="Job not found")
        state = VmafJobState(job_id=job_id, reference_path=reference, status="reference_ready")
    return _to_response(state)


if __name__ == "__main__":
    import uvicorn

    from config import HOST

    uvicorn.run("main:app", host=HOST, port=PORT, reload=False)
