import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlparse, urlunparse
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from live_webcam import DEFAULT_LIVE_DURATION_SEC, MAX_LIVE_DURATION_SEC, live_webcam_manager

ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from destinations import (  # noqa: E402
    PROTOCOL_LABELS,
    SYNTAX_BY_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    PRESET_BY_ID,
    DestinationConfigError,
    ingest_agent_url_for_preset,
    presets_for_api,
    recording_dir_for_preset,
    resolve_destination_request,
)
from endpoint_probe import probe_endpoint  # noqa: E402
from ingest_agent_client import IngestAgentClient, resolve_ingest_agent, vmaf_available_for_endpoint  # noqa: E402
from vmaf_score import libvmaf_available  # noqa: E402
from encode_profile import (  # noqa: E402
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_TARGET_LATENCY_MS,
    MAX_TARGET_LATENCY_MS,
    MIN_TARGET_LATENCY_MS,
    clamp_target_latency_ms,
    encode_profile_summary,
    ensure_known_ladder,
    list_encode_ladders,
)
from upload_service import UploadJob  # noqa: E402
from job_manager import (  # noqa: E402
    JobManager,
    JobStatus,
    VmafStatus,
    list_result_files,
    read_result_summary,
)

UPLOADS_DIR = ROOT_DIR / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

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
    # When omitted, the API uses the media file duration (ffprobe).
    duration_sec: Optional[int] = Field(default=None, ge=5, le=3600)
    preset_id: Optional[str] = None
    protocol: Optional[str] = None
    endpoint_url: Optional[str] = None
    compute_vmaf_on_ingest: bool = False
    compute_vmaf_encoder: bool = False
    encode_ladder: str = DEFAULT_ENCODE_LADDER_ID
    target_latency_ms: int = Field(
        default=DEFAULT_TARGET_LATENCY_MS,
        ge=MIN_TARGET_LATENCY_MS,
        le=MAX_TARGET_LATENCY_MS,
    )
    comparison_id: Optional[str] = None
    stream_index: int = Field(default=0, ge=0, le=9)
    stream_label: str = ""


def probe_media_duration_sec(media_path: str) -> int:
    """Return media duration in seconds (clamped), defaulting to 60 on failure."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return 60
    try:
        completed = subprocess.run(
            [
                ffprobe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                media_path,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
        raw = (completed.stdout or "").strip()
        duration = float(raw)
        if duration <= 0 or duration != duration:  # NaN
            return 60
        return max(5, min(3600, int(round(duration))))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 60


class PlaybackSampleRequest(BaseModel):
    elapsed_sec: int = Field(ge=0)
    engine: str = ""
    playback_stats_events: int = 0
    playback_stall_count: int = 0
    playback_frames_rendered: int = 0
    playback_frames_dropped: int = 0
    playback_bitrate_bps: float = 0.0
    playback_ttff_ms: float = 0.0
    playback_hls_errors: int = 0
    playback_hls_fatal_errors: int = 0
    playback_hls_buffer_stalls: int = 0
    playback_hls_frag_loads: int = 0
    playback_video_time_sec: float = 0.0
    playback_buffer_sec: float = 0.0
    playback_rebuffer_sec: float = 0.0
    playback_error_count: int = 0
    e2e_latency_ms: float = 0.0


def job_to_dict(job) -> dict:
    return {
        "id": job.id,
        "status": job.status.value,
        "protocol": job.protocol,
        "endpoint_url": job.endpoint_url,
        "media_path": job.media_path,
        "duration_sec": job.duration_sec,
        "preset_id": job.preset_id,
        "encode_ladder": getattr(job, "encode_ladder", None),
        "target_latency_ms": getattr(job, "target_latency_ms", None),
        "moq_namespace": job.moq_namespace,
        "zixi_stream_id": job.zixi_stream_id,
        "preview_ready": getattr(job, "preview_ready", True),
        "created_at": job.created_at,
        "csv_path": job.csv_path,
        "summary_path": job.summary_path,
        "error": job.error,
        "samples": job.samples,
        "compute_vmaf_on_ingest": job.compute_vmaf_on_ingest,
        "compute_vmaf_encoder": job.compute_vmaf_encoder,
        "vmaf_status": job.vmaf_status,
        "vmaf_score": job.vmaf_score,
        "psnr_db": job.psnr_db,
        "ssim": job.ssim,
        "vmaf_error": job.vmaf_error,
        "encoder_vmaf_status": job.encoder_vmaf_status,
        "encoder_vmaf_score": job.encoder_vmaf_score,
        "encoder_psnr_db": job.encoder_psnr_db,
        "encoder_ssim": job.encoder_ssim,
        "encoder_vmaf_error": job.encoder_vmaf_error,
        "started_at_epoch": job.started_at_epoch,
    }


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/encode-profiles")
def encode_profiles():
    """Bitrate ladder presets + latency bounds for the upload configuration UI."""
    return {
        "ladders": list_encode_ladders(),
        "default_ladder": DEFAULT_ENCODE_LADDER_ID,
        "default_target_latency_ms": DEFAULT_TARGET_LATENCY_MS,
        "min_target_latency_ms": MIN_TARGET_LATENCY_MS,
        "max_target_latency_ms": MAX_TARGET_LATENCY_MS,
        "example": encode_profile_summary(DEFAULT_ENCODE_LADDER_ID, DEFAULT_TARGET_LATENCY_MS),
        "notes": {
            "latency": (
                "Target latency is a glass-to-glass budget: encoder GOP/bufsize, "
                "SRT/Zixi latency, MoQ player targetLatencyMs, and HLS liveSync depth."
            ),
            "srt_rtmp_playback": (
                "Browsers cannot open srt:// or rtmp:// natively. Use Zixi HLS/MPEG-TS, "
                "WHEP (WebRTC), or MoQ/WebTransport for in-page preview."
            ),
        },
    }


@app.post("/api/media/upload")
async def upload_media(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    suffix = Path(file.filename).suffix or ".mp4"
    media_id = str(uuid.uuid4())
    target_name = f"{media_id}{suffix}"
    target_path = UPLOADS_DIR / target_name

    try:
        with open(target_path, "wb") as handle:
            shutil.copyfileobj(file.file, handle)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not save upload: {exc}") from exc

    return {
        "media_id": media_id,
        "filename": file.filename,
        "media_path": str(target_path),
        "size_bytes": target_path.stat().st_size,
    }


@app.get("/api/endpoints/probe")
def endpoint_probe(
    endpoint_url: str = "",
    preset_id: str = "",
    media_path: str = "",
):
    resolved_url = endpoint_url.strip()
    protocol = ""
    if preset_id:
        try:
            destination = resolve_destination_request(preset_id=preset_id)
            resolved_url = destination.url
            protocol = destination.protocol
        except DestinationConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    elif endpoint_url:
        from urllib.parse import urlparse

        protocol = urlparse(endpoint_url).scheme
        if protocol == "rtmp":
            protocol = "rtmp"
        else:
            raise HTTPException(
                status_code=400,
                detail="Provide preset_id or an rtmp:// endpoint_url for probe",
            )
    else:
        raise HTTPException(status_code=400, detail="Provide endpoint_url or preset_id")

    media = media_path.strip() or str(ROOT_DIR / "dummy.mp4")
    if not os.path.isabs(media):
        media = str(ROOT_DIR / media)
    if not os.path.exists(media):
        raise HTTPException(status_code=400, detail=f"Media file not found: {media}")

    ok, error = probe_endpoint(protocol, resolved_url, media)
    return {
        "ok": ok,
        "protocol": protocol,
        "endpoint_url": resolved_url,
        "error": error,
    }


@app.get("/api/vmaf/available")
def vmaf_available(
    endpoint_url: str = "",
    preset_id: str = "",
):
    resolved_url = endpoint_url.strip()
    if preset_id:
        try:
            resolved_url = resolve_destination_request(preset_id=preset_id).url
        except DestinationConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not resolved_url:
        raise HTTPException(status_code=400, detail="Provide endpoint_url or preset_id")

    preset = PRESET_BY_ID.get(preset_id) if preset_id else None
    if preset is not None and not preset.supports_vmaf:
        return {
            "available": False,
            "endpoint_url": resolved_url,
            "reason": "This preset does not support ingest VMAF",
        }

    available = vmaf_available_for_endpoint(
        resolved_url,
        preset_id=preset_id,
    )
    return {
        "available": available,
        "endpoint_url": resolved_url,
        "reason": (
            ""
            if available
            else "VMAF is not configured for this destination on the server"
        ),
    }


@app.get("/api/quality/available")
def quality_available(
    endpoint_url: str = "",
    preset_id: str = "",
):
    encoder_available = libvmaf_available()
    encoder_reason = (
        ""
        if encoder_available
        else "ffmpeg libvmaf filter is not available on this machine"
    )

    resolved_url = endpoint_url.strip()
    if preset_id:
        try:
            resolved_url = resolve_destination_request(preset_id=preset_id).url
        except DestinationConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    ingest_available = False
    ingest_reason = "Provide endpoint_url or preset_id to check ingest VMAF"
    if resolved_url:
        preset = PRESET_BY_ID.get(preset_id) if preset_id else None
        if preset is not None and not preset.supports_vmaf:
            ingest_reason = "This preset does not support ingest VMAF"
        elif vmaf_available_for_endpoint(resolved_url, preset_id=preset_id):
            ingest_available = True
            ingest_reason = ""
        else:
            ingest_reason = "VMAF is not configured for this destination on the server"

    return {
        "encoder": {
            "available": encoder_available,
            "reason": encoder_reason,
        },
        "ingest": {
            "available": ingest_available,
            "endpoint_url": resolved_url,
            "reason": ingest_reason,
        },
    }


@app.get("/api/ingest-agent/health")
def ingest_agent_health(
    endpoint_url: str,
    preset_id: str = "",
):
    resolved_url = endpoint_url.strip()
    if preset_id:
        try:
            resolved_url = resolve_destination_request(preset_id=preset_id).url
        except DestinationConfigError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    config = resolve_ingest_agent(
        resolved_url,
        agent_url=ingest_agent_url_for_preset(preset_id) if preset_id else "",
        recording_dir=recording_dir_for_preset(preset_id) if preset_id else "",
    )
    if config is None:
        raise HTTPException(
            status_code=400,
            detail="VMAF ingest agent is not configured for this destination",
        )

    try:
        payload = IngestAgentClient(config).health()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "agent_url": config.base_url,
        "recording_dir": config.recording_dir,
        **payload,
    }


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
    items = presets_for_api(web_only=True)
    if protocol:
        items = [item for item in items if item["protocol"] == protocol]
    return {"presets": items}


class CreateLiveSessionRequest(BaseModel):
    stream_count: int = Field(default=2, ge=1, le=9)
    duration_sec: int = Field(default=DEFAULT_LIVE_DURATION_SEC, ge=5, le=MAX_LIVE_DURATION_SEC)


@app.post("/api/live/sessions")
def create_live_session(request: CreateLiveSessionRequest):
    try:
        session = live_webcam_manager.create(
            stream_count=request.stream_count,
            duration_sec=request.duration_sec,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "session_id": session.id,
        "duration_sec": session.duration_sec,
        "media_paths": session.media_paths,
        "ws_path": f"/api/live/sessions/{session.id}/ws",
    }


@app.websocket("/api/live/sessions/{session_id}/ws")
async def live_session_ws(websocket: WebSocket, session_id: str):
    session = live_webcam_manager.get(session_id)
    if session is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    await websocket.send_json({"type": "accepted", "session_id": session_id})
    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data:
                session.write(data)
                if session.failed:
                    await websocket.send_json({"type": "error", "message": session.failed})
                    break
                if session.ready.is_set() and not session._ready_notified:
                    session._ready_notified = True
                    await websocket.send_json({"type": "ready", "bytes_in": session._bytes_in})
            text = message.get("text")
            if text == "end":
                break
    except WebSocketDisconnect:
        pass
    finally:
        live_webcam_manager.close(session_id)


@app.post("/api/uploads")
def create_upload(request: CreateUploadRequest):
    media_path = request.media_path.strip()
    is_live = media_path.lower().startswith(("udp://", "tcp://", "rtsp://"))
    if not is_live:
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

    # Live webcam has no stable reference file for VMAF.
    compute_vmaf_on_ingest = request.compute_vmaf_on_ingest and not is_live
    compute_vmaf_encoder = request.compute_vmaf_encoder and not is_live

    if compute_vmaf_on_ingest:
        preset = PRESET_BY_ID.get(request.preset_id or destination.preset_id)
        if preset is not None and not preset.supports_vmaf:
            raise HTTPException(
                status_code=400,
                detail="Ingest VMAF is not supported for this preset.",
            )
        preset_id = request.preset_id or destination.preset_id
        if not vmaf_available_for_endpoint(destination.url, preset_id=preset_id):
            raise HTTPException(
                status_code=400,
                detail="VMAF is not available for this destination. Use a managed ingest endpoint.",
            )

    if compute_vmaf_encoder and not libvmaf_available():
        raise HTTPException(
            status_code=400,
            detail="Encoder VMAF requires ffmpeg with libvmaf on this machine.",
        )

    duration_sec = request.duration_sec
    if duration_sec is None:
        if is_live:
            duration_sec = DEFAULT_LIVE_DURATION_SEC
        else:
            duration_sec = probe_media_duration_sec(media_path)
    if is_live:
        duration_sec = max(5, min(MAX_LIVE_DURATION_SEC, int(duration_sec)))

    try:
        encode_ladder = ensure_known_ladder(request.encode_ladder)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    target_latency_ms = clamp_target_latency_ms(request.target_latency_ms)

    job = UploadJob(
        media_path=media_path,
        destination=destination,
        duration_sec=duration_sec,
        compute_vmaf_on_ingest=compute_vmaf_on_ingest,
        compute_vmaf_encoder=compute_vmaf_encoder,
        encode_ladder=encode_ladder,
        target_latency_ms=target_latency_ms,
        comparison_id=request.comparison_id or "",
        stream_index=request.stream_index,
        stream_label=request.stream_label,
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


@app.post("/api/uploads/{job_id}/playback-sample")
def post_playback_sample(job_id: str, request: PlaybackSampleRequest):
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in {JobStatus.PENDING, JobStatus.RUNNING}:
        raise HTTPException(status_code=409, detail="Upload is not active")

    accepted = job_manager.record_playback_sample(job_id, request.model_dump())
    if not accepted:
        raise HTTPException(status_code=400, detail="Invalid playback sample")
    return {"ok": True}


@app.post("/api/uploads/{job_id}/stop")
def stop_upload(job_id: str):
    """Request cooperative cancel of a running upload (used by live webcam Stop)."""
    if not job_manager.request_cancel(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"ok": True, "status": "stopping"}


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
                "summary_path": current.summary_path,
                "error": current.error,
                "moq_namespace": current.moq_namespace,
                "vmaf_status": current.vmaf_status,
                "vmaf_score": current.vmaf_score,
                "psnr_db": current.psnr_db,
                "ssim": current.ssim,
                "vmaf_error": current.vmaf_error,
                "encoder_vmaf_status": current.encoder_vmaf_status,
                "encoder_vmaf_score": current.encoder_vmaf_score,
                "encoder_psnr_db": current.encoder_psnr_db,
                "encoder_ssim": current.encoder_ssim,
                "encoder_vmaf_error": current.encoder_vmaf_error,
            }
            yield f"event: status\ndata: {json.dumps(payload)}\n\n"

            if current.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                if current.status == JobStatus.FAILED:
                    break
                if not current.compute_vmaf_on_ingest:
                    break
                if current.vmaf_status in {
                    VmafStatus.COMPLETED.value,
                    VmafStatus.FAILED.value,
                    VmafStatus.DISABLED.value,
                }:
                    break

            await asyncio.sleep(1)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


_M3U8_URI_ATTR_RE = re.compile(r'URI="([^"]+)"')


def _is_m3u8_manifest(url: str, media_type: str, content: bytes) -> bool:
    if ".m3u8" in urlparse(url).path.lower():
        return True
    if "mpegurl" in media_type.lower() or "m3u8" in media_type.lower():
        return True
    stripped = content.lstrip()
    return stripped.startswith(b"#EXTM3U")


def _sanitize_fetch_url(url: str) -> str:
    """Encode query/path so urllib can fetch Zixi URLs with spaces (e.g. stream=SRT Test).

    Must use %20 (not urlencode's default '+') for spaces — Zixi's HTTP origin
    does not decode '+' as a space and will 403 on a literal 'SRT+Test' lookup.
    """
    parsed = urlparse(url)
    query = urlencode(parse_qsl(parsed.query, keep_blank_values=True), quote_via=quote)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, query, parsed.fragment))


def _unwrap_nested_playback_fetch_url(url: str) -> str:
    """Undo accidental double-proxy URLs (http://zixi/api/playback/fetch?url=http://zixi/playback.ts)."""
    current = url
    for _ in range(3):
        parsed = urlparse(current)
        if "/api/playback/fetch" not in (parsed.path or ""):
            return current
        params = dict(parse_qsl(parsed.query, keep_blank_values=True))
        inner = (params.get("url") or "").strip()
        if not inner.startswith("http"):
            return current
        current = inner
    return current


def _proxied_playback_path(remote_url: str) -> str:
    return f"/api/playback/fetch?url={quote(_sanitize_fetch_url(remote_url), safe='')}"


def _rewrite_m3u8_manifest(manifest_url: str, content: bytes) -> bytes:
    text = content.decode("utf-8", errors="replace")
    rewritten: list[str] = []

    for line in text.splitlines():
        if 'URI="' in line:
            def replace_uri(match: re.Match[str]) -> str:
                absolute = urljoin(manifest_url, match.group(1))
                return f'URI="{_proxied_playback_path(absolute)}"'

            rewritten.append(_M3U8_URI_ATTR_RE.sub(replace_uri, line))
            continue

        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            absolute = urljoin(manifest_url, stripped)
            rewritten.append(_proxied_playback_path(absolute))
            continue

        rewritten.append(line)

    body = "\n".join(rewritten)
    if text.endswith("\n"):
        body += "\n"
    return body.encode("utf-8")


_MPD_URL_ATTR_RE = re.compile(
    r'\b(media|initialization|mediaRange|sourceURL)="([^"]+)"',
    re.IGNORECASE,
)
_MPD_BASEURL_RE = re.compile(
    r"(<BaseURL[^>]*>)(.*?)(</BaseURL>)",
    re.IGNORECASE | re.DOTALL,
)


def _is_mpd_manifest(url: str, media_type: str, content: bytes) -> bool:
    path = urlparse(url).path.lower()
    if path.endswith(".mpd") or ".mpd" in path:
        return True
    if "dash+xml" in media_type.lower() or "mpd" in media_type.lower():
        return True
    stripped = content.lstrip()[:200].lower()
    return stripped.startswith(b"<?xml") and b"<mpd" in stripped


def _absolutize_mpd_url(manifest_url: str, value: str) -> str:
    """Turn relative DASH template/segment URLs into absolute Zixi URLs.

    Keep ``$RepresentationID$`` / ``$Number$`` placeholders intact so dash.js
    can still substitute them. Do **not** wrap in /api/playback/fetch here —
    DashPlayer's request modifier proxies the final substituted URL.
    """
    value = value.strip()
    if not value or value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith("/api/playback/fetch"):
        return value
    return urljoin(manifest_url, value)


def _rewrite_mpd_manifest(manifest_url: str, content: bytes) -> bytes:
    """Prevent dash.js from resolving relative .m4s URLs under /api/playback/.

    Without this, SegmentTemplate media=\"playback.m4s?...\" becomes
    GET /api/playback/playback.m4s (404) instead of the Zixi origin.
    """
    text = content.decode("utf-8", errors="replace")

    def replace_attr(match: re.Match[str]) -> str:
        attr, value = match.group(1), match.group(2)
        return f'{attr}="{_absolutize_mpd_url(manifest_url, value)}"'

    text = _MPD_URL_ATTR_RE.sub(replace_attr, text)

    def replace_baseurl(match: re.Match[str]) -> str:
        open_tag, value, close_tag = match.group(1), match.group(2), match.group(3)
        return f"{open_tag}{_absolutize_mpd_url(manifest_url, value)}{close_tag}"

    text = _MPD_BASEURL_RE.sub(replace_baseurl, text)
    return text.encode("utf-8")


@app.get("/api/playback/fetch")
def playback_fetch(url: str):
    url = _unwrap_nested_playback_fetch_url(url)
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Only http(s) playback URLs are allowed")
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid playback URL")

    safe_url = _sanitize_fetch_url(url)
    path_lower = (parsed.path or "").lower()
    likely_m3u8 = path_lower.endswith(".m3u8") or "m3u8" in path_lower
    likely_mpd = path_lower.endswith(".mpd") or ".mpd" in path_lower
    likely_manifest = likely_m3u8 or likely_mpd
    # Zixi long-polls live playlists until the next segment (~chunk duration,
    # min 2s). Keep this tight and well under hls.js's own manifestLoadingTimeOut
    # (10s) so a slow poll surfaces as a fast retry, not a client-side fatal
    # timeout race. On timeout return a real error so hls.js retries and keeps
    # its previous playlist — do NOT return an empty #EXTM3U here, that
    # replaces a valid live playlist and kills playback.
    timeout = 5 if likely_manifest else 20
    request = urllib.request.Request(safe_url, method="GET")
    no_store = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
    }
    # Propagate upstream 404 so waitForManifest / hls.js can keep polling without
    # replacing a live playlist with an empty #EXTM3U stub (that causes fatal
    # levelParsingError with http=200 once the Zixi input is torn down).
    try:
        upstream = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=exc.code, detail=f"Playback upstream error: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Playback fetch failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="Playback fetch timed out") from exc

    media_type = upstream.headers.get("Content-Type", "application/octet-stream")
    if likely_manifest or "mpegurl" in media_type.lower() or "m3u8" in media_type.lower() or "dash+xml" in media_type.lower():
        try:
            content = upstream.read()
        finally:
            upstream.close()
        if likely_m3u8 or "mpegurl" in media_type.lower() or "m3u8" in media_type.lower():
            stripped = content.lstrip()
            if not stripped.startswith(b"#EXTM3U"):
                raise HTTPException(
                    status_code=502,
                    detail="Upstream returned a non-playlist body for an m3u8 URL",
                )
            if _is_m3u8_manifest(url, media_type, content):
                content = _rewrite_m3u8_manifest(url, content)
                media_type = "application/vnd.apple.mpegurl"
            return Response(content=content, media_type=media_type, headers=no_store)
        if likely_mpd or _is_mpd_manifest(url, media_type, content):
            if not _is_mpd_manifest(url, media_type, content):
                raise HTTPException(
                    status_code=502,
                    detail="Upstream returned a non-MPD body for an mpd URL",
                )
            content = _rewrite_mpd_manifest(url, content)
            media_type = "application/dash+xml"
            return Response(content=content, media_type=media_type, headers=no_store)

    def iter_chunks():
        try:
            while True:
                chunk = upstream.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()

    # Stream TS/DASH segments — buffering the full body added multi-hundred-ms TTFF.
    return StreamingResponse(iter_chunks(), media_type=media_type, headers=no_store)


@app.get("/api/playback/probe")
def playback_probe(url: str):
    """Fetch manifest + first media segment and return structured playback diagnostics."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Only http(s) playback URLs are allowed")
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid playback URL")

    safe_manifest_url = _sanitize_fetch_url(url)
    result: dict = {
        "manifest_url": safe_manifest_url,
        "manifest_ok": False,
        "manifest_bytes": 0,
        "segment_url": None,
        "segment_ok": False,
        "segment_bytes": 0,
        "checks": [],
    }

    try:
        with urllib.request.urlopen(urllib.request.Request(safe_manifest_url, method="GET"), timeout=15) as response:
            manifest = response.read()
    except urllib.error.HTTPError as exc:
        result["checks"].append(f"manifest_http_{exc.code}")
        return result
    except urllib.error.URLError as exc:
        result["checks"].append(f"manifest_fetch_failed:{exc.reason}")
        return result

    if not _is_m3u8_manifest(url, "application/vnd.apple.mpegurl", manifest):
        result["checks"].append("manifest_not_m3u8")
        return result

    result["manifest_ok"] = True
    result["manifest_bytes"] = len(manifest)
    rewritten = _rewrite_m3u8_manifest(url, manifest).decode("utf-8", errors="replace")
    segment_line = ""
    for line in rewritten.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            segment_line = stripped
            break

    if not segment_line:
        result["checks"].append("manifest_has_no_segment_lines")
        return result

    if segment_line.startswith("/api/playback/fetch"):
        result["checks"].append("manifest_segments_proxied_ok")
        upstream_line = ""
        for raw_line in manifest.decode("utf-8", errors="replace").splitlines():
            raw_stripped = raw_line.strip()
            if raw_stripped and not raw_stripped.startswith("#"):
                upstream_line = urljoin(url, raw_stripped)
                break
        segment_url = _sanitize_fetch_url(upstream_line)
    else:
        segment_url = _sanitize_fetch_url(urljoin(url, segment_line))

    result["segment_url"] = segment_url
    try:
        with urllib.request.urlopen(urllib.request.Request(segment_url, method="GET"), timeout=15) as response:
            segment = response.read()
    except urllib.error.HTTPError as exc:
        result["checks"].append(f"segment_http_{exc.code}")
        return result
    except urllib.error.URLError as exc:
        result["checks"].append(f"segment_fetch_failed:{exc.reason}")
        return result

    result["segment_ok"] = len(segment) > 0
    result["segment_bytes"] = len(segment)
    if result["segment_ok"]:
        result["checks"].append("segment_download_ok")
        decode_check = _probe_segment_decodable(segment)
        result["segment_decodable"] = decode_check["decodable"]
        result["segment_video"] = decode_check.get("video")
        if decode_check["decodable"]:
            result["checks"].append("segment_ffprobe_ok")
        else:
            result["checks"].append(f"segment_ffprobe_failed:{decode_check.get('reason', 'unknown')}")
    else:
        result["checks"].append("segment_empty")
        result["segment_decodable"] = False
    return result


def _probe_segment_decodable(segment: bytes) -> dict:
    import subprocess
    import tempfile

    if not shutil.which("ffprobe"):
        return {"decodable": None, "reason": "ffprobe_not_installed"}

    with tempfile.NamedTemporaryFile(suffix=".ts", delete=True) as tmp:
        tmp.write(segment)
        tmp.flush()
        try:
            proc = subprocess.run(
                [
                    "ffprobe",
                    "-hide_banner",
                    "-v",
                    "error",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=codec_name,profile,pix_fmt,width,height",
                    "-of",
                    "csv=p=0",
                    tmp.name,
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            return {"decodable": False, "reason": str(exc)}

    stderr = (proc.stderr or "").strip()
    stdout = (proc.stdout or "").strip()
    if proc.returncode != 0 or not stdout or "no frame" in stderr.lower() or "pps" in stderr.lower():
        reason = stderr.splitlines()[-1] if stderr else "no_video_stream"
        return {"decodable": False, "reason": reason, "video": stdout or None}
    return {"decodable": True, "video": stdout}


# SHA-256 hashes of relay TLS leaf certs (hex, no colons).
# moqx serves QUIC/WebTransport only on UDP :4433 — browsers cannot fetch
# https://relay:4433/fingerprint over TCP. Serve hashes from our API instead.
MOQ_RELAY_CERT_SHA256: dict[str, str] = {
    # ECDSA self-signed cert (14-day) for WebTransport browser pinning — see
    # infra/moqx/scripts/configure-webtransport-cert.sh
    "34-28-164-90.sslip.io": "7115b12274dcf092c3e77d763111f0a2088a0f2029efc8e1f223a9584b1f5b54",
}


@app.get("/api/moq/probe")
def moq_probe(relay_admin: str = "http://34.28.164.90:8000"):
    """Fetch moqx relay subscribe/publish metrics for playback diagnostics."""
    metrics_url = f"{relay_admin.rstrip('/')}/metrics"
    result: dict = {
        "relay_admin": metrics_url,
        "reachable": False,
        "subscribe_success": None,
        "subscribe_error": None,
        "subscribe_error_track_not_exist": None,
        "publish_namespace_success": None,
        "checks": [],
    }
    try:
        with urllib.request.urlopen(urllib.request.Request(metrics_url, method="GET"), timeout=10) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as exc:
        result["checks"].append(f"metrics_unreachable:{exc.reason}")
        return result

    result["reachable"] = True

    def metric_value(name: str, labels: str = "") -> int | None:
        needle = name
        if labels:
            needle = f'{name}{{{labels}}}'
        for line in body.splitlines():
            if line.startswith("#") or not line.strip():
                continue
            if needle in line or line.startswith(f"{name} "):
                try:
                    return int(float(line.rsplit(" ", 1)[-1]))
                except ValueError:
                    return None
        return None

    result["subscribe_success"] = metric_value("moqx_pubSubscribeSuccess_total")
    result["subscribe_error"] = metric_value("moqx_pubSubscribeError_total")
    result["subscribe_error_track_not_exist"] = metric_value(
        "moqx_pubSubscribeError_by_code_total",
        'code="track_not_exist"',
    )
    result["publish_namespace_success"] = metric_value("moqx_pubPublishNamespaceSuccess_total")
    result["publish_received"] = metric_value("moqx_moqPublishReceived_total")
    result["publish_done"] = metric_value("moqx_pubPublishDone_total")

    publish_seen = (result["publish_received"] or 0) > 0 or (result["publish_done"] or 0) > 0
    if (result["subscribe_error_track_not_exist"] or 0) > 0 and not publish_seen:
        result["checks"].append("subscribe_track_not_exist")
    if (result["publish_namespace_success"] or 0) == 0 and not publish_seen:
        result["checks"].append("publish_never_received")
    if (result["subscribe_success"] or 0) == 0 and (result["subscribe_error"] or 0) > 0 and not publish_seen:
        result["checks"].append("subscribe_always_fails")
    if result["checks"]:
        result["checks"].append("relay_playback_broken")
    else:
        result["checks"].append("relay_metrics_look_healthy")
    return result


@app.get("/api/moq/fingerprint")
def moq_fingerprint(relay: str):
    parsed = urlparse(relay)
    if parsed.scheme not in {"https", "http"}:
        raise HTTPException(status_code=400, detail="Relay URL must be http(s)")
    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="Invalid relay URL")

    fingerprint = MOQ_RELAY_CERT_SHA256.get(host)
    if not fingerprint:
        raise HTTPException(
            status_code=404,
            detail=f"No TLS fingerprint configured for relay host '{host}'",
        )

    return Response(content=fingerprint, media_type="text/plain")


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


@app.get("/api/results/{filename}/download")
def download_result(filename: str, kind: str = "csv"):
    """Download the raw CSV sample log or the .summary.json for a result file."""
    if ".." in filename or "/" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    kind_normalized = (kind or "csv").strip().lower()
    if kind_normalized not in {"csv", "json", "summary"}:
        raise HTTPException(status_code=400, detail="kind must be csv or json")

    if kind_normalized == "csv":
        path = ROOT_DIR / "results" / filename
        media_type = "text/csv"
        download_name = filename
    else:
        base = filename[:-4] if filename.endswith(".csv") else filename
        path = ROOT_DIR / "results" / f"{base}.summary.json"
        media_type = "application/json"
        download_name = f"{base}.summary.json"

    if not path.exists():
        raise HTTPException(status_code=404, detail="Result file not found")

    return FileResponse(
        path,
        media_type=media_type,
        filename=download_name,
    )


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
