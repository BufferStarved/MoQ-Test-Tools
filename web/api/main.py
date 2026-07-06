import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from destinations import (  # noqa: E402
    PROTOCOL_LABELS,
    SYNTAX_BY_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    DestinationConfigError,
    presets_for_api,
    resolve_destination_request,
)
from upload_service import UploadJob  # noqa: E402
from job_manager import (  # noqa: E402
    JobManager,
    JobStatus,
    list_result_files,
    read_result_summary,
)

app = FastAPI(title="MoQ Test Tools", version="1.0.0")
job_manager = JobManager()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateUploadRequest(BaseModel):
    media_path: str = "dummy.mp4"
    duration_sec: int = Field(default=30, ge=5, le=3600)
    preset_id: Optional[str] = None
    protocol: Optional[str] = None
    endpoint_url: Optional[str] = None


def job_to_dict(job) -> dict:
    return {
        "id": job.id,
        "status": job.status.value,
        "protocol": job.protocol,
        "endpoint_url": job.endpoint_url,
        "media_path": job.media_path,
        "duration_sec": job.duration_sec,
        "preset_id": job.preset_id,
        "created_at": job.created_at,
        "csv_path": job.csv_path,
        "error": job.error,
        "samples": job.samples,
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/protocols")
def protocols():
    return {
        "protocols": [
            {
                "id": protocol,
                "label": PROTOCOL_LABELS[protocol],
                "syntax": SYNTAX_BY_PROTOCOL[protocol],
            }
            for protocol in SUPPORTED_PROTOCOLS
        ]
    }


@app.get("/api/presets")
def presets(protocol: Optional[str] = None):
    items = presets_for_api()
    if protocol:
        items = [item for item in items if item["protocol"] == protocol]
    return {"presets": items}


@app.post("/api/uploads")
def create_upload(request: CreateUploadRequest):
    media_path = request.media_path
    if not os.path.isabs(media_path):
        media_path = str(ROOT_DIR / media_path)

    if not os.path.exists(media_path):
        raise HTTPException(status_code=400, detail=f"Media file not found: {media_path}")

    try:
        destination = resolve_destination_request(
            preset_id=request.preset_id,
            protocol=request.protocol,
            endpoint_url=request.endpoint_url,
        )
    except DestinationConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    job = UploadJob(
        media_path=media_path,
        destination=destination,
        duration_sec=request.duration_sec,
    )
    record = job_manager.create_job(job, preset_id=request.preset_id or destination.preset_id)
    return job_to_dict(record)


@app.get("/api/uploads")
def list_uploads():
    return {"jobs": [job_to_dict(job) for job in job_manager.list_jobs()]}


@app.get("/api/uploads/{job_id}")
def get_upload(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job_to_dict(job)


@app.get("/api/uploads/{job_id}/events")
async def upload_events(job_id: str):
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_stream():
        seen = 0
        while True:
            current = job_manager.get_job(job_id)
            if not current:
                break

            while seen < len(current.samples):
                yield f"data: {json.dumps(current.samples[seen])}\n\n"
                seen += 1

            payload = {
                "status": current.status.value,
                "csv_path": current.csv_path,
                "error": current.error,
            }
            yield f"event: status\ndata: {json.dumps(payload)}\n\n"

            if current.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                break

            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/results")
def results():
    result_dir = str(ROOT_DIR / "results")
    return {"results": list_result_files(result_dir)}


@app.get("/api/results/{filename}")
def result_detail(filename: str):
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    csv_path = ROOT_DIR / "results" / filename
    if not csv_path.exists():
        raise HTTPException(status_code=404, detail="Result not found")

    summary = read_result_summary(str(csv_path))
    return {"filename": filename, **summary}


FRONTEND_DIST = ROOT_DIR / "web" / "frontend" / "dist"
if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="assets")

    @app.get("/")
    def serve_frontend():
        return FileResponse(FRONTEND_DIST / "index.html")
else:
    @app.get("/")
    def root():
        return {
            "message": "MoQ Test Tools API is running. Build the frontend with `npm run build` in web/frontend.",
        }
