import logging
import os
import shutil
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from config import API_TOKEN, PORT, RECORDING_DIR, WORK_DIR
from host_metrics import read_host_metrics
from recording_service import RecordingState, get_recording_state, start_moq_recording, stop_moq_recording
from ts_capture import (
    TsCaptureState,
    get_http_ts_capture_state,
    start_http_ts_capture,
    stop_http_ts_capture,
)
from vmaf_service import (
    VmafJobState,
    get_vmaf_state,
    job_dir,
    reference_path_for,
    start_compute_vmaf,
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
    http_ts_url: str = ""


class HttpTsCaptureStartRequest(BaseModel):
    url: str
    duration_sec: int = Field(default=30, ge=5, le=3600)


class HttpTsCaptureResponse(BaseModel):
    job_id: str
    status: str
    output_path: str = ""
    url: str = ""
    error: str = ""
    pid: Optional[int] = None


class RecordingStartRequest(BaseModel):
    namespace: str
    duration_sec: int = Field(default=60, ge=5, le=3600)
    relay_url: str = ""
    recording_dir: str = ""
    cert_sha256: str = ""
    # Browser LOC advertises `video`; cloud openmoq CMAF advertises `vide_1`.
    video_track: str = ""


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
    # Wrapper existing is not enough — Dallas advertised available while
    # `openmoq-recorder:latest` was missing. `docker image inspect` is
    # milliseconds; do not `--probe` (that hung job start).
    image = os.environ.get("MOQ_RECORDER_IMAGE", "openmoq-recorder:latest")
    image_ok = False
    image_err = ""
    if recorder_bin_ok and shutil.which("docker"):
        import subprocess

        try:
            inspected = subprocess.run(
                ["docker", "image", "inspect", image],
                capture_output=True,
                timeout=3,
                check=False,
            )
            image_ok = inspected.returncode == 0
            if not image_ok:
                image_err = f"docker image {image} missing"
        except (OSError, subprocess.TimeoutExpired) as exc:
            image_err = str(exc)
    elif recorder_bin_ok:
        image_err = "docker not on PATH"
    else:
        image_err = "recorder binary missing"
    return {
        "status": "ok",
        "service": "moq-ingest-agent",
        "recording_dir": RECORDING_DIR,
        "ffmpeg": ffmpeg or "",
        "libvmaf_available": bool(ffmpeg),
        "moq_recorder_bin": MOQ_RECORDER_BIN,
        "moq_recorder_available": recorder_bin_ok and image_ok,
        "moq_recorder_runtime_ok": recorder_bin_ok and image_ok,
        "moq_recorder_runtime_error": image_err,
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


def _fetch_local(url: str, timeout: float = 1.0) -> str:
    request = urllib.request.Request(url, headers={"Accept": "text/plain, application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


@app.get("/api/v1/moqx/metrics", dependencies=[Depends(verify_token)])
def moqx_metrics(port: int = 18000) -> dict:
    """Loopback scrape of this host's moqx Prometheus admin.

    Draft-18 canary admin is TCP 18000 and is not public. Leftover draft-16
    is 8000. Callers must pass the port for the WebTransport they published.
    """
    if port not in {8000, 18000}:
        raise HTTPException(status_code=400, detail="Invalid moqx admin port")
    try:
        body = _fetch_local(f"http://127.0.0.1:{port}/metrics")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"moqx metrics unavailable: {exc}") from exc
    return {"ok": True, "body": body, "port": port}


@app.get("/api/v1/mediamtx/metrics", dependencies=[Depends(verify_token)])
def mediamtx_metrics() -> dict:
    """Loopback Prometheus scrape so a remote encode host can read this MediaMTX."""
    try:
        body = _fetch_local("http://127.0.0.1:9998/metrics")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"MediaMTX metrics unavailable: {exc}") from exc
    return {"ok": True, "body": body}


@app.get("/api/v1/mediamtx/paths/{path_name}", dependencies=[Depends(verify_token)])
def mediamtx_path(path_name: str) -> dict:
    safe = "".join(ch for ch in path_name if ch.isalnum() or ch in {"_", "-"})
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid MediaMTX path")
    try:
        body = _fetch_local(f"http://127.0.0.1:9997/v3/paths/get/{safe}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"MediaMTX path API unavailable: {exc}") from exc
    return {"ok": True, "body": body}


@app.get("/api/v1/zixi/input-stats", dependencies=[Depends(verify_token)])
def zixi_input_stats(func: str = "fill_inputs_stats", id: str = "") -> dict:
    """Loopback Zixi REST so a remote encode host can read this Broadcaster."""
    allowed = {"fill_inputs_stats", "fill_ts_anaysis_data"}
    if func not in allowed:
        raise HTTPException(status_code=400, detail="Invalid Zixi stats function")
    input_id = (id or "").strip()
    if not input_id:
        raise HTTPException(status_code=400, detail="Missing Zixi input id")
    encoded_id = urllib.parse.quote(input_id, safe="")
    url = f"http://127.0.0.1:4444/input_stream_stats.json?func={func}&id={encoded_id}"
    request = urllib.request.Request(url)
    user = os.environ.get("ZIXI_API_USER", "admin")
    password = os.environ.get("ZIXI_API_PASSWORD", "")
    if password:
        import base64

        token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
        request.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(request, timeout=0.8) as response:
            body = response.read().decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Zixi stats unavailable: {exc}") from exc
    return {"ok": True, "body": body}


@app.post("/api/v1/jobs/{job_id}/recording/start", dependencies=[Depends(verify_token)])
def start_recording(job_id: str, request: RecordingStartRequest) -> RecordingResponse:
    try:
        state = start_moq_recording(
            job_id,
            namespace=request.namespace,
            duration_sec=request.duration_sec,
            relay_url=request.relay_url,
            recording_dir=request.recording_dir,
            cert_sha256=request.cert_sha256,
            video_track=request.video_track,
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


def _ts_capture_to_response(state: TsCaptureState) -> HttpTsCaptureResponse:
    return HttpTsCaptureResponse(
        job_id=state.job_id,
        status=state.status,
        output_path=state.output_path,
        url=state.url,
        error=state.error,
        pid=state.pid,
    )


@app.post("/api/v1/jobs/{job_id}/http-ts-capture/start", dependencies=[Depends(verify_token)])
def start_ts_capture(job_id: str, request: HttpTsCaptureStartRequest) -> HttpTsCaptureResponse:
    try:
        state = start_http_ts_capture(
            job_id,
            url=request.url,
            duration_sec=request.duration_sec,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _ts_capture_to_response(state)


@app.post("/api/v1/jobs/{job_id}/http-ts-capture/stop", dependencies=[Depends(verify_token)])
def stop_ts_capture(job_id: str) -> HttpTsCaptureResponse:
    try:
        state = stop_http_ts_capture(job_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _ts_capture_to_response(state)


@app.get("/api/v1/jobs/{job_id}/http-ts-capture", dependencies=[Depends(verify_token)])
def ts_capture_status(job_id: str) -> HttpTsCaptureResponse:
    state = get_http_ts_capture_state(job_id)
    if state is None:
        raise HTTPException(status_code=404, detail="HTTP-TS capture not found")
    return _ts_capture_to_response(state)


@app.post("/api/v1/jobs/{job_id}/vmaf", dependencies=[Depends(verify_token)])
def run_vmaf(job_id: str, request: VmafComputeRequest) -> JobResponse:
    if request.end_epoch < request.start_epoch:
        raise HTTPException(status_code=400, detail="end_epoch must be >= start_epoch")

    state = start_compute_vmaf(
        job_id=job_id,
        start_epoch=request.start_epoch,
        end_epoch=request.end_epoch,
        recording_dir=request.recording_dir,
        http_ts_url=request.http_ts_url,
    )
    _jobs[job_id] = state
    logger.info("VMAF job %s status=%s score=%s", job_id, state.status, state.vmaf_score)
    return _to_response(state)


@app.get("/api/v1/jobs/{job_id}", dependencies=[Depends(verify_token)])
def get_job(job_id: str) -> JobResponse:
    state = get_vmaf_state(job_id) or _jobs.get(job_id)
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
