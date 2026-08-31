import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.request
from datetime import datetime, timezone

import httpx
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlparse, urlunparse
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from build_info import read_build_sha, read_moq_env

# Max duration for a live source (device webcam via the local publisher
# agent) — user can stop earlier from the UI.
DEFAULT_LIVE_DURATION_SEC = 300
MAX_LIVE_DURATION_SEC = 300

ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from destinations import (  # noqa: E402
    PROTOCOL_LABELS,
    SYNTAX_BY_PROTOCOL,
    WEB_OFFERED_PROTOCOLS,
    PRESET_BY_ID,
    DestinationConfigError,
    http_ts_put_preset_blocked,
    ingest_agent_url_for_preset,
    zixi_gcp_encode_blocked,
    presets_for_api,
    recording_dir_for_preset,
    resolve_destination_request,
)
from endpoint_probe import probe_endpoint  # noqa: E402
from ingest_agent_client import (  # noqa: E402
    IngestAgentClient,
    resolve_ingest_agent,
    vmaf_availability_for_endpoint,
)
from vmaf_score import libvmaf_available  # noqa: E402
from encode_profile import (  # noqa: E402
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_MOQ_TARGET_LATENCY_MS,
    DEFAULT_TARGET_LATENCY_MS,
    MAX_TARGET_LATENCY_MS,
    MIN_TARGET_LATENCY_MS,
    build_video_encode_args,
    SRT_MIN_TARGET_LATENCY_MS,
    clamp_target_latency_ms,
    encode_profile_summary,
    ensure_known_ladder,
    list_encode_ladders,
    with_srt_latency,
)
from moq_publish import (  # noqa: E402
    BROWSER_COMPAT_AUDIO_ARGS,
    MPEGTS_VIDEO_BSF,
    OBS_OPENMOQ_MEDIA,
    is_device_browser_source,
    is_device_webcam_source,
    is_obs_openmoq_source,
    with_srt_stream_id,
    zixi_srt_streamid_value,
)
from vod_assets import (  # noqa: E402
    clip_vod_duration_sec,
    media_source_catalog,
    resolve_bundled_vod,
)
from upload_service import UploadJob  # noqa: E402
from job_manager import (  # noqa: E402
    JobManager,
    JobStatus,
    VmafStatus,
    list_result_files,
    read_result_summary,
)
from publisher_hub import (  # noqa: E402
    _is_prod_env,
    local_publisher_enabled,
    local_publisher_token,
    normalize_publisher_session,
    publisher_hub,
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
    expose_headers=["Location"],
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
    playback_policy: str = "live-edge"
    test_scope: str = "e2e"
    comparison_id: Optional[str] = None
    stream_index: int = Field(default=0, ge=0, le=9)
    stream_label: str = ""
    # "cloud" = encode on API host. "local" = laptop ffmpeg agent.
    # "browser" = in-page WebCodecs + WebTransport (no terminal agent).
    publisher_host: str = "cloud"
    encoder: str = "ffmpeg"
    # Per-browser helper binding. Required on prod so jobs use that
    # visitor's laptop camera, never a shared operator helper.
    publisher_session: str = ""


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
    # Browser wall-clock (unix seconds) when the sample was taken. Lets the
    # server rebase elapsed_sec onto the pipeline sample base (see
    # JobManager.record_playback_sample) instead of trusting the browser's
    # start anchor, which uses a different zero point.
    at_epoch: float = 0.0
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
    #: Seconds queued AHEAD of the playhead. The only quantity the latency
    #: budget's player-buffer stage consumes.
    playback_buffer_sec: float = 0.0
    #: Seconds the glass is BEHIND live (MoQ LOC canvas only). Opposite
    #: direction from playback_buffer_sec, so it is kept separate and never
    #: summed into the latency chain.
    playback_behind_live_sec: float = 0.0
    playback_rebuffer_sec: float = 0.0
    playback_error_count: int = 0
    e2e_latency_ms: float = 0.0
    go_live_at_sec: float = 0.0
    go_live_e2e_ms: float = 0.0
    #: Startup decomposition, player half (src/startup_budget.py). Durations in
    #: ms from the browser's own instruments, reconciling against
    #: playback_ttff_ms.
    #:
    #: These default to None, not 0.0, and that is the point: a phase the
    #: browser cannot source (no manifest on a raw MPEG-TS pull, or Resource
    #: Timing marks zeroed by cross-origin opacity) has to stay distinguishable
    #: from a phase that completed inside the measurement resolution. A 0.0
    #: default here would silently convert every unmeasured phase into a
    #: confident zero before it ever reached the CSV.
    startup_player_request_ms: Optional[float] = None
    startup_manifest_ms: Optional[float] = None
    startup_first_media_ms: Optional[float] = None
    startup_first_paint_ms: Optional[float] = None


def job_to_dict(job) -> dict:
    slot = job_manager.encode_slot_fields(job)
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
        "playback_policy": getattr(job, "playback_policy", None) or "live-edge",
        "test_scope": getattr(job, "test_scope", None) or "e2e",
        "publisher_host": getattr(job, "publisher_host", "cloud"),
        "moq_namespace": job.moq_namespace,
        "zixi_stream_id": job.zixi_stream_id,
        "zixi_playback_stream_id": getattr(job, "zixi_playback_stream_id", None),
        "preview_ready": getattr(job, "preview_ready", True),
        "waiting_for_encode_slot": slot["waiting_for_encode_slot"],
        "encode_queue_ahead": slot["encode_queue_ahead"],
        "encode_slot_limit": slot["encode_slot_limit"],
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
        "first_sample_at_epoch": getattr(job, "first_sample_at_epoch", None),
        "media_zero_epoch": getattr(job, "media_zero_epoch", None),
        "packager_transit_ms": getattr(job, "packager_transit_ms", None),
        "delivery_media_origin_sec": getattr(job, "delivery_media_origin_sec", None),
        "cancelled": bool(getattr(job, "cancel_event", None) and job.cancel_event.is_set()),
    }


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "git_sha": read_build_sha(ROOT_DIR),
        "env": read_moq_env(),
    }


@app.get("/api/time")
def server_time():
    """Server wall clock for the browser's clock-skew probe.

    Job epochs (started_at_epoch, first_sample_at_epoch) are stamped with
    THIS host's clock; the browser corrects Date.now() against it so
    wall-minus-playhead latency estimates aren't polluted by client clock
    drift (see web/frontend/src/clockSkew.ts).
    """
    return {"epoch": time.time()}


@app.get("/api/features")
def features(session: str = ""):
    """Feature flags for the UI. Agent list is scoped to this browser session."""
    hub = publisher_hub.status(normalize_publisher_session(session))
    from cloud_placement import encode_hosts_for_api

    return {
        "local_publisher": bool(hub.get("enabled")),
        "local_publisher_connected": bool(hub.get("connected")),
        "local_publisher_whip": bool(hub.get("whip")),
        "local_publisher_obs": hub.get("obs") or {
            "websocket": False,
            "plugin": False,
            "detail": "",
        },
        "local_publisher_agents": hub.get("agents") or [],
        "encode_hosts": encode_hosts_for_api(),
        "media_sources": media_source_catalog(ROOT_DIR),
    }


@app.get("/run-local-publisher.sh")
def launch_local_publisher_script():
    """Bootstrap the laptop helper from any cwd (the Webcam copy-paste command)."""
    path = ROOT_DIR / "scripts" / "launch-local-publisher.sh"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Launcher script is not installed")
    return FileResponse(
        path,
        media_type="text/x-shellscript",
        filename="run-local-publisher.sh",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/publisher-session")
def create_publisher_session():
    """Mint a helper binding so Webcam+ffmpeg uses this browser's laptop only."""
    sess = publisher_hub.mint_session()
    return {"session_id": sess.session_id, "expires_at": sess.expires_at}


@app.websocket("/api/publisher-agent/ws")
async def publisher_agent_ws(websocket: WebSocket):
    """Laptop helper. Prod requires a minted browser session — never a shared pool."""
    if not local_publisher_enabled():
        await websocket.close(code=1008)
        return
    session = normalize_publisher_session(websocket.query_params.get("session") or "")
    token = (websocket.query_params.get("token") or "").strip()
    if _is_prod_env():
        if not publisher_hub.valid_session(session):
            await websocket.close(code=1008)
            return
    elif session:
        if not publisher_hub.valid_session(session):
            await websocket.close(code=1008)
            return
    elif token != local_publisher_token():
        await websocket.close(code=1008)
        return
    agent_id = (websocket.query_params.get("agent_id") or "").strip() or f"agent-{uuid.uuid4().hex[:8]}"
    await websocket.accept()
    conn = await publisher_hub.register(websocket, agent_id, session_id=session)
    try:
        while True:
            message = await websocket.receive_json()
            if isinstance(message, dict):
                await publisher_hub.handle_agent_message(conn, message)
    except WebSocketDisconnect:
        pass
    finally:
        publisher_hub.unregister(agent_id, websocket)


@app.get("/api/encode-profiles")
def encode_profiles():
    """Bitrate ladder presets + latency bounds for the upload configuration UI."""
    return {
        "ladders": list_encode_ladders(),
        "default_ladder": DEFAULT_ENCODE_LADDER_ID,
        "default_target_latency_ms": DEFAULT_TARGET_LATENCY_MS,
        "default_moq_target_latency_ms": DEFAULT_MOQ_TARGET_LATENCY_MS,
        "min_target_latency_ms": MIN_TARGET_LATENCY_MS,
        "srt_min_target_latency_ms": SRT_MIN_TARGET_LATENCY_MS,
        "max_target_latency_ms": MAX_TARGET_LATENCY_MS,
        "example": encode_profile_summary(DEFAULT_ENCODE_LADDER_ID, DEFAULT_TARGET_LATENCY_MS),
        "notes": {
            "latency": (
                "HLS/SRT/Zixi keep a 2s segmented-delivery floor. MoQ does not inherit "
                "that floor — encode GOP and the player target stay at the MoQ budget "
                f"({DEFAULT_MOQ_TARGET_LATENCY_MS} ms)."
            ),
            "srt_rtmp_playback": (
                "Browsers cannot open srt:// or rtmp:// natively. Use Zixi HLS/MPEG-TS, "
                "WHEP (WebRTC), or MoQ/WebTransport for in-page preview."
            ),
        },
    }


def _zixi_public_host() -> str:
    preset = PRESET_BY_ID.get("moq_zixi_gcp")
    if preset and preset.url.startswith("srt://"):
        return urlparse(preset.url).hostname or "35.222.33.58"
    return "35.222.33.58"


@app.get("/api/debug/zixi-srt")
def debug_zixi_srt(
    encode_ladder: str = DEFAULT_ENCODE_LADDER_ID,
    target_latency_ms: int = DEFAULT_TARGET_LATENCY_MS,
    stream_id: str = "SRT Test",
):
    """Vendor-facing publish recipe + curl templates for Fast HLS debugging.

    No credentials. Safe to share with Zixi support while reproducing SRT→HLS stalls.
    """
    import shlex

    try:
        ladder = ensure_known_ladder(encode_ladder)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    latency_ms = clamp_target_latency_ms(target_latency_ms)
    host = _zixi_public_host()
    stream = (stream_id or "SRT Test").strip() or "SRT Test"
    summary = encode_profile_summary(ladder, latency_ms)
    video_args = build_video_encode_args(ladder, latency_ms)
    srt_base = f"srt://{host}:10080"
    srt_url = with_srt_latency(with_srt_stream_id(srt_base, stream), latency_ms)
    playlist_url = f"http://{host}:7777/playback.m3u8?stream={quote(stream)}"
    segment_url = f"http://{host}:7777/playback.ts?stream={quote(stream)}&chunk=0"
    http_ts_url = f"http://{host}:7777/{quote(stream)}.ts"
    ffmpeg_example = shlex.join(
        [
            "ffmpeg",
            "-re",
            "-i",
            "SOURCE.mp4",
            *video_args,
            *BROWSER_COMPAT_AUDIO_ARGS,
            "-output_ts_offset",
            "OFFSET_SEC",
            "-bsf:v",
            MPEGTS_VIDEO_BSF,
            "-f",
            "mpegts",
            "udp://127.0.0.1:PORT?pkt_size=1316",
        ]
    )
    srt_transmit_example = (
        f"srt-live-transmit udp://:@127.0.0.1:PORT {shlex.quote(srt_url)}"
    )
    return {
        "broadcaster": {
            "host": host,
            "ui": f"http://{host}:4444",
            "srt_listen_port": 10080,
            "hls_origin_port": 7777,
            "build_hint": "46908 (UI `version=46908`; v19.0 family)",
            "srt_input": "listener (broadcaster listens; publisher calls in)",
            "fast_hls": f"http://{host}:7777/playback.m3u8?stream=<stream-id>",
        },
        "stream_id": stream,
        "streamid_payload": zixi_srt_streamid_value(stream),
        "pipeline": (
            "ffmpeg (H.264+AAC → MPEG-TS) → local UDP → srt-live-transmit → "
            "Zixi SRT listener. Fallback: ffmpeg libsrt caller directly to the same URL."
        ),
        "encode": summary,
        "video_notes": {
            "codec": "libx264 main@L4.0 yuv420p",
            "gop_frames": summary.get("gop_frames"),
            "keyframe_interval_sec": round(float(summary.get("gop_frames") or 0) / 30.0, 3),
            "x264_params": "repeat-headers=1",
            "bsf": MPEGTS_VIDEO_BSF,
            "global_header": False,
            "b_frames": 0,
            "sc_threshold": 0,
        },
        "audio": "aac 128k 48kHz stereo (-flags:a +bitexact)",
        "ffmpeg_example": ffmpeg_example,
        "srt_transmit_example": srt_transmit_example,
        "srt_url": srt_url,
        "playlist_url": playlist_url,
        "segment_url_chunk0": segment_url,
        "http_ts_url": http_ts_url,
        "curl_playlist": f'curl -v "{playlist_url}"',
        "curl_segment_chunk0": f'curl -v -o /tmp/chunk0.ts "{segment_url}"',
        "curl_http_ts": f'curl -v -o /tmp/live.ts "{http_ts_url}"',
        "root_cause": (
            "Fast HLS builds a single-segment packager on first playlist hit and reuses it "
            "across SRT reconnects. File publishes that rewind PTS behind the packager "
            "high-water mark stall the playlist until the timeline catches up (Zixi eng)."
        ),
        "player_attach": (
            "Browser confidence monitor mounts after the SRT publish job is running, "
            "and only goes live once a Fast HLS segment returns a non-empty MPEG-TS body "
            "(preview_ready). Typical case: push starts first; player attaches mid-session "
            "as soon as the playlist/segment become readable — not before publish."
        ),
        "reconnect": (
            f"Same SRT stream id every run (`{stream}`). Jobs are serialized. "
            "Managed publishes apply a monotonic ffmpeg -output_ts_offset so each file "
            "session starts above the previous Fast HLS high-water mark (no delete+recreate "
            "required). Mid-job heal may still reset the input if the playlist wedges. "
            "Force the old preflight with ZIXI_SRT_RESET_BEFORE_PUBLISH=1. "
            "For VMAF/ULL monitor prefer raw HTTP-TS "
            f"({http_ts_url}) when http_ts_auto_out=1."
        ),
        "config_scripts": [
            "https://github.com/BufferStarved/MoQ-Test-Tools/blob/main/infra/zixi/scripts/configure-zixi-hls-dash-output.sh",
            "https://github.com/BufferStarved/MoQ-Test-Tools/blob/main/infra/zixi/scripts/reset-zixi-srt-input.sh",
            "https://github.com/BufferStarved/MoQ-Test-Tools/blob/main/src/zixi_input_reset.py",
        ],
        "site_capture": (
            "On https://moq.sean-mccarthy.net run an SRT benchmark, open the SRT player "
            "→ Playback diagnostics → Capture stuck playlist. That returns the raw "
            "playback.m3u8 body plus the failing segment status/headers (item 4)."
        ),
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

    available, ingest_reason = vmaf_availability_for_endpoint(
        resolved_url,
        preset_id=preset_id,
    )
    return {
        "available": available,
        "endpoint_url": resolved_url,
        "reason": "" if available else ingest_reason,
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
        else:
            ingest_available, ingest_reason = vmaf_availability_for_endpoint(
                resolved_url,
                preset_id=preset_id,
            )

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
            for protocol in WEB_OFFERED_PROTOCOLS
        ]
    }


@app.get("/api/presets")
def presets(protocol: Optional[str] = None):
    items = presets_for_api(web_only=True)
    if protocol:
        items = [item for item in items if item["protocol"] == protocol]
    return {"presets": items}


@app.post("/api/uploads")
def create_upload(request: CreateUploadRequest):
    media_path = request.media_path.strip()
    encoder = (request.encoder or "ffmpeg").strip().lower()
    if encoder not in {"ffmpeg", "obs"}:
        raise HTTPException(status_code=400, detail="encoder must be 'ffmpeg' or 'obs'")
    if encoder == "obs":
        media_path = OBS_OPENMOQ_MEDIA
    device_webcam = is_device_webcam_source(media_path)
    device_browser = is_device_browser_source(media_path)
    obs_source = is_obs_openmoq_source(media_path)
    is_live = device_webcam or device_browser or obs_source

    publisher_host = (request.publisher_host or "cloud").strip().lower()
    if encoder == "obs":
        publisher_host = "local"
    if publisher_host not in {"cloud", "local", "browser"}:
        raise HTTPException(
            status_code=400,
            detail="publisher_host must be 'cloud', 'local', or 'browser'",
        )

    publisher_session = normalize_publisher_session(request.publisher_session)
    if publisher_host == "local":
        if not local_publisher_enabled():
            raise HTTPException(
                status_code=400,
                detail=(
                    "Local publisher is not enabled on this API. "
                    "Use ./scripts/dev.sh (sets LOCAL_PUBLISHER_ENABLED=1)."
                ),
            )
        if _is_prod_env() and not publisher_hub.valid_session(publisher_session):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Webcam+ffmpeg needs a helper started from this browser session "
                    "so it uses your camera, not someone else's."
                ),
            )
        if not publisher_hub.status(publisher_session).get("connected"):
            raise HTTPException(
                status_code=503,
                detail=(
                    "No local publisher agent connected for this browser. "
                    "Run the helper command shown under Webcam, then retry."
                ),
            )
        # Local acquisition: webcam, OBS OpenMOQ, or a user-chosen file — not repo VOD.
        lower = media_path.lower()
        if obs_source:
            media_path = OBS_OPENMOQ_MEDIA
        elif lower.endswith("dummy.mp4") or "big buck" in lower or lower.endswith("/bbb"):
            raise HTTPException(
                status_code=400,
                detail=(
                    "VOD presets are for cloud encode only. "
                    "Pick a local file or webcam (device:webcam) for This machine."
                ),
            )
        if not device_webcam and not obs_source:
            if media_path.lower().startswith("udp://"):
                raise HTTPException(
                    status_code=400,
                    detail="UDP loopback sources are internal (webcam broker). Use device:webcam or a local file.",
                )
            if not os.path.isabs(media_path):
                media_path = str(ROOT_DIR / media_path)
            if not os.path.exists(media_path):
                raise HTTPException(status_code=400, detail=f"Media file not found: {media_path}")
            # Prefer files the user uploaded into uploads/ (shared with the agent).
            try:
                media_path = str(Path(media_path).resolve())
            except OSError:
                pass
        else:
            # Normalize case but keep the optional camera index from the UI
            # picker (device:webcam:N) so the agent opens the chosen device.
            media_path = lower
    elif publisher_host == "browser":
        if not device_browser:
            raise HTTPException(
                status_code=400,
                detail="publisher_host=browser requires media_path device:browser.",
            )
        media_path = "device:browser"
    elif device_browser:
        raise HTTPException(
            status_code=400,
            detail="media_path device:browser requires publisher_host=browser.",
        )
    else:
        if not is_live:
            bundled = resolve_bundled_vod(ROOT_DIR, media_path)
            if bundled is not None:
                media_path = str(bundled)
            else:
                lower_name = Path(media_path).name.lower()
                if lower_name in {"bbb.mp4", "bbb", "bbb.mov", "big_buck_bunny.mp4", "bigbuckbunny.mp4"}:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "Big Buck Bunny is not on this host. Place bbb.mp4 next to dummy.mp4 "
                            "or run scripts/fetch-bbb.sh."
                        ),
                    )
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

    put_blocked = http_ts_put_preset_blocked(request.preset_id or destination.preset_id)
    if put_blocked:
        raise HTTPException(status_code=400, detail=put_blocked)

    zixi_blocked = zixi_gcp_encode_blocked(
        request.preset_id or destination.preset_id,
        url=destination.url,
    )
    if zixi_blocked:
        raise HTTPException(status_code=400, detail=zixi_blocked)

    if publisher_host == "browser" and destination.protocol not in {"moq", "webrtc"}:
        raise HTTPException(
            status_code=400,
            detail="Browser publish supports MoQ and WebRTC (WHIP). Use a MoQ relay or MediaMTX WHIP destination.",
        )

    if encoder == "obs" and destination.protocol == "webrtc":
        raise HTTPException(
            status_code=400,
            detail="OBS encode supports SRT, RTMP, and MoQ — not WebRTC.",
        )

    if encoder == "obs" and destination.protocol == "moq":
        haystack = f"{destination.url} {destination.preset_id}"
        if ":14433" in haystack or "draft=18" in haystack or "_d18" in (destination.preset_id or ""):
            raise HTTPException(
                status_code=400,
                detail=(
                    "OBS OpenMOQ plugin is draft-16 only. Public MoQ is draft-18 "
                    "(:14433). Use ffmpeg (helper) for MoQ."
                ),
            )

    if publisher_host == "local" and destination.protocol == "webrtc":
        if not publisher_hub.can_publish_whip(publisher_session):
            raise HTTPException(
                status_code=400,
                detail=(
                    "This laptop cannot publish WebRTC yet. Use SRT, RTMP, or MoQ, "
                    "or switch to Cloud playout or Browser."
                ),
            )

    # Ingest VMAF: file sources upload the original media as reference.
    # Browser publish has no file — the tab uploads the encoded bitstream
    # during the run, so ingest scoring is allowed. Device webcams still
    # cannot (raw capture cannot be stream-copied as a reference).
    # Encoder VMAF stays off for both live device sources (no ffmpeg capture
    # on the API for browser; raw webcam cannot mux a copy).
    compute_vmaf_on_ingest = request.compute_vmaf_on_ingest and (not is_live or device_browser)
    compute_vmaf_encoder = (
        request.compute_vmaf_encoder
        and not device_webcam
        and not obs_source
        and not device_browser
        and destination.protocol != "webrtc"
    )

    if compute_vmaf_on_ingest:
        preset = PRESET_BY_ID.get(request.preset_id or destination.preset_id)
        if preset is not None and not preset.supports_vmaf:
            raise HTTPException(
                status_code=400,
                detail="Ingest VMAF is not supported for this preset.",
            )
        preset_id = request.preset_id or destination.preset_id
        available, vmaf_reason = vmaf_availability_for_endpoint(
            destination.url, preset_id=preset_id
        )
        if not available:
            # Missing regional token must not 401 the ingest agent or block encode.
            # Dead public Zixi :8090 is skip-listed — do not spawn a VMAF worker
            # that would POST/upload into 35.222.33.58. Encode still runs.
            compute_vmaf_on_ingest = False

    if compute_vmaf_encoder and not libvmaf_available():
        # Encoder VMAF for local publisher runs on the agent — still require
        # libvmaf on the API host for cloud; for local we allow the request and
        # let the agent fail clearly if libvmaf is missing there.
        if publisher_host != "local":
            raise HTTPException(
                status_code=400,
                detail="Encoder VMAF requires ffmpeg with libvmaf on this machine.",
            )

    duration_sec = request.duration_sec
    if is_live:
        if duration_sec is None:
            duration_sec = DEFAULT_LIVE_DURATION_SEC
        duration_sec = max(5, min(MAX_LIVE_DURATION_SEC, int(duration_sec)))
    else:
        duration_sec = clip_vod_duration_sec(
            probed_sec=probe_media_duration_sec(media_path),
            requested=duration_sec,
            bundled=resolve_bundled_vod(ROOT_DIR, media_path) is not None
            or Path(media_path).name.lower()
            in {"dummy.mp4", "bbb.mp4", "bbb.mov", "big_buck_bunny.mp4", "bigbuckbunny.mp4"},
        )

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
        playback_policy=(
            "complete" if (request.playback_policy or "").strip() == "complete" else "live-edge"
        ),
        test_scope="upload" if (request.test_scope or "").strip() == "upload" else "e2e",
        comparison_id=request.comparison_id or "",
        stream_index=request.stream_index,
        stream_label=request.stream_label,
        publisher_host=publisher_host,
        encoder=encoder,
        publisher_session=publisher_session,
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

    payload = request.model_dump()
    payload["playback_policy"] = getattr(job, "playback_policy", None) or "live-edge"
    accepted = job_manager.record_playback_sample(job_id, payload)
    if not accepted:
        raise HTTPException(status_code=400, detail="Invalid playback sample")
    return {"ok": True}


class EncodeSampleRequest(BaseModel):
    # WHIP posts performance.now()/1000 floats; MoQ rounds. Accept both.
    elapsed_sec: float = Field(ge=0)
    encoded_bitrate_kbps: float = 0.0
    fps: float = 0.0
    encoder_send_rate_mbps: float = 0.0
    encode_lag_ms: float = 0.0
    transport_rtt_ms: float = 0.0
    transport_rtt_jitter_ms: float = 0.0
    net_rtt_ms: float = 0.0
    net_jitter_ms: float = 0.0
    net_send_mbps: float = 0.0
    net_recv_mbps: float = 0.0
    transport_recv_rate_mbps: float = 0.0
    net_loss_pct: float = 0.0
    net_retrans_pct: float = 0.0
    pkt_snd_loss: float = 0.0
    pkt_retrans: float = 0.0
    # WebRTC cannot tee encoder VMAF; publishers may send a QP-mapped 0–100
    # quality stand-in so the comparison quality column is not blank.
    vmaf_score: Optional[float] = None
    progress: str = "continue"


@app.post("/api/uploads/{job_id}/encode-sample")
def post_encode_sample(job_id: str, request: EncodeSampleRequest):
    """Browser WASM publisher encode telemetry (no ffmpeg -progress)."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in {JobStatus.PENDING, JobStatus.RUNNING}:
        raise HTTPException(status_code=409, detail="Upload is not active")
    if getattr(job, "publisher_host", "") != "browser":
        raise HTTPException(status_code=400, detail="encode-sample is for browser publishers")
    payload = request.model_dump()
    payload["elapsed_sec"] = int(round(float(payload.get("elapsed_sec") or 0)))
    accepted = job_manager.record_browser_encode_sample(job_id, payload)
    if not accepted:
        raise HTTPException(status_code=400, detail="Invalid encode sample")
    return {"ok": True}


@app.post("/api/uploads/{job_id}/publisher-ready")
def post_publisher_ready(job_id: str):
    """Browser publisher finished WebTransport + PUBLISH_NAMESPACE."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in {JobStatus.PENDING, JobStatus.RUNNING}:
        raise HTTPException(status_code=409, detail="Upload is not active")
    if getattr(job, "publisher_host", "") != "browser":
        raise HTTPException(status_code=400, detail="publisher-ready is for browser publishers")
    if not job_manager.mark_browser_publisher_ready(job_id):
        raise HTTPException(status_code=400, detail="Could not mark publisher ready")
    return {"ok": True}


class PublisherErrorRequest(BaseModel):
    error: str = Field(..., min_length=1, max_length=500)


@app.post("/api/uploads/{job_id}/publisher-error")
def post_publisher_error(job_id: str, request: PublisherErrorRequest):
    """Browser publisher failed this leg (WHIP ICE / MoQ relay). Surface it on the job."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in {JobStatus.PENDING, JobStatus.QUEUED, JobStatus.RUNNING}:
        raise HTTPException(status_code=409, detail="Upload is not active")
    if getattr(job, "publisher_host", "") != "browser":
        raise HTTPException(status_code=400, detail="publisher-error is for browser publishers")
    if not job_manager.fail_browser_publisher(job_id, request.error):
        raise HTTPException(status_code=400, detail="Could not fail browser publisher")
    return {"ok": True}


@app.post("/api/uploads/{job_id}/vmaf-reference")
async def post_browser_vmaf_reference(job_id: str, file: UploadFile = File(...)):
    """In-tab encoder bitstream used as the ingest VMAF reference (not encoder VMAF)."""
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status not in {JobStatus.PENDING, JobStatus.RUNNING}:
        raise HTTPException(status_code=409, detail="Upload is not active")
    if getattr(job, "publisher_host", "") != "browser":
        raise HTTPException(status_code=400, detail="vmaf-reference is for browser publishers")
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Empty reference payload")
    filename = file.filename or "reference.h264"
    error = job_manager.attach_browser_vmaf_reference(job_id, payload, filename)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return {"ok": True}


class PlaybackDiagRequest(BaseModel):
    engine: str = ""
    lines: list[str] = Field(default_factory=list)


@app.post("/api/uploads/{job_id}/playback-diag")
def post_playback_diag(job_id: str, request: PlaybackDiagRequest):
    """Persist browser player diagnostics (pushDiag lines) per job.

    Playback misbehavior (stalls, rescues, restarts) previously lived only in
    the player card's diagnostics panel and died with the tab — every field
    report required asking the tester to copy console output. Appending them
    server-side makes any run fully post-mortemable from the API alone.
    """
    job = job_manager.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    lines = [str(line)[:500] for line in request.lines[:200]]
    if not lines:
        return {"ok": True, "written": 0}
    diag_dir = ROOT_DIR / "results" / "playback-diag"
    diag_dir.mkdir(parents=True, exist_ok=True)
    path = diag_dir / f"{job_id}.log"
    stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
    with path.open("a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(f"{stamp} [{request.engine}] {line}\n")
    return {"ok": True, "written": len(lines)}


@app.get("/api/uploads/{job_id}/playback-diag")
def get_playback_diag(job_id: str):
    path = ROOT_DIR / "results" / "playback-diag" / f"{job_id}.log"
    if not path.exists():
        raise HTTPException(status_code=404, detail="No diagnostics for this job")
    return Response(content=path.read_text(encoding="utf-8"), media_type="text/plain")


@app.post("/api/uploads/{job_id}/stop")
def stop_upload(job_id: str):
    """Request cooperative cancel of a running upload (used by live webcam Stop).

    Do not 404 when the in-memory job is gone (API restart). The helper may
    still be encoding — fan the cancel out, and let the UI unwind.
    """
    found = job_manager.request_cancel(job_id)
    publisher_hub.broadcast_cancel(job_id)
    return {"ok": True, "status": "stopping" if found else "already_gone"}


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

            slot = job_manager.encode_slot_fields(current)
            payload = {
                "status": current.status.value,
                "preview_ready": getattr(current, "preview_ready", True),
                "waiting_for_encode_slot": slot["waiting_for_encode_slot"],
                "encode_queue_ahead": slot["encode_queue_ahead"],
                "encode_slot_limit": slot["encode_slot_limit"],
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
                # Latency anchors are only known after the run starts (the
                # first live sample sets first_sample_at_epoch), but the UI
                # snapshots the job right at creation — without these in the
                # status stream the browser never learns the anchor and every
                # wall−playhead e2e estimate (RTMP HTTP-TS) stays 0.
                "started_at_epoch": current.started_at_epoch,
                "first_sample_at_epoch": getattr(current, "first_sample_at_epoch", None),
                "media_zero_epoch": getattr(current, "media_zero_epoch", None),
                "packager_transit_ms": getattr(current, "packager_transit_ms", None),
                "delivery_media_origin_sec": getattr(
                    current, "delivery_media_origin_sec", None
                ),
                "cancelled": current.cancel_event.is_set(),
            }
            yield f"event: status\ndata: {json.dumps(payload)}\n\n"

            if current.status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                if current.status == JobStatus.FAILED:
                    break
                encoder_pending = current.compute_vmaf_encoder and current.encoder_vmaf_status not in {
                    VmafStatus.COMPLETED.value,
                    VmafStatus.FAILED.value,
                    VmafStatus.DISABLED.value,
                }
                ingest_pending = current.compute_vmaf_on_ingest and current.vmaf_status not in {
                    VmafStatus.COMPLETED.value,
                    VmafStatus.FAILED.value,
                    VmafStatus.DISABLED.value,
                }
                if not encoder_pending and not ingest_pending:
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


# Shared keep-alive client for the playback proxy. The old implementation
# used sync urllib on FastAPI's threadpool: every LL-HLS *blocking* playlist
# reload parked a thread for up to 5s, every raw HTTP-TS stream pinned one for
# the whole session, and each request opened a fresh TCP connection. With a
# 3-leg comparison playing (playlist long-polls + ~5 part fetches/sec + a
# continuous TS stream) the pool jittered every player at once — the
# browser-side symptom was stutter on all legs and wedged fragment loading.
_playback_client: Optional[httpx.AsyncClient] = None

# Zixi live HTTP-TS answers 200 then hangs: Content-Length is INT64_MAX
# (or omitted) and the body never starts. Distinct from connect/host-down.
_ZIXI_UNBOUNDED_CONTENT_LENGTH = 2**63 - 1
_HTTP_TS_FIRST_BYTE_SEC = 2.5
PLAYBACK_FETCH_TIMED_OUT = "Playback fetch timed out"


def _content_length_is_unbounded(value: Optional[str]) -> bool:
    if value is None or str(value).strip() == "":
        return True
    try:
        length = int(str(value).strip())
    except ValueError:
        return True
    return length >= _ZIXI_UNBOUNDED_CONTENT_LENGTH


def is_live_http_ts(path: str, headers) -> bool:
    """Continuous HTTP-TS (Zixi named outputs), not finite HLS .ts segments."""
    content_type = (headers.get("Content-Type") if headers is not None else "") or ""
    lowered = content_type.lower()
    path_l = (path or "").lower()
    looks_ts = (
        "mp2t" in lowered
        or "mpegts" in lowered
        or "mpeg2ts" in lowered
        or path_l.endswith(".ts")
    )
    if not looks_ts:
        return False
    return _content_length_is_unbounded(
        headers.get("Content-Length") if headers is not None else None
    )


def playback_fetch_idle_detail(upstream_status: int) -> str:
    return f"Playback fetch: origin answered HTTP {upstream_status} but sent no media"


def playback_fetch_idle_response(upstream_status: int) -> Response:
    """504 the player can tell from host-down 504 (no X-Playback-First-Byte)."""
    return Response(
        status_code=504,
        content=json.dumps({"detail": playback_fetch_idle_detail(upstream_status)}),
        media_type="application/json",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Playback-Upstream-Status": str(upstream_status),
            "X-Playback-First-Byte": "idle",
        },
    )


def _get_playback_client() -> httpx.AsyncClient:
    global _playback_client
    if _playback_client is None or _playback_client.is_closed:
        _playback_client = httpx.AsyncClient(
            follow_redirects=True,
            # Zixi's "Internal Web Server" replies with Content-Encoding: zstd
            # whenever *any* Accept-Encoding header is present — even if zstd
            # wasn't offered. If the venv lacks the zstandard package, httpx
            # returns the raw zstd bytes, which fail the #EXTM3U check and 502
            # every playlist poll (RTMP leg stuck on "Waiting for live HLS
            # manifest…", 2026-08-09). Manifests are tiny and TS/fMP4 media is
            # already compressed, so force identity instead of relying on
            # optional decompression codecs being installed.
            headers={"Accept-Encoding": "identity"},
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=40),
            # read=20s is a per-chunk-read deadline on streamed bodies, so a
            # live TS stream stays healthy as long as bytes keep flowing.
            timeout=httpx.Timeout(connect=5.0, read=20.0, write=20.0, pool=10.0),
        )
    return _playback_client


def _is_webrtc_signaling_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    path = (parsed.path or "").lower()
    return "whip" in path or "whep" in path


@app.api_route("/api/webrtc/sdp", methods=["POST", "PATCH", "DELETE"])
async def webrtc_sdp_proxy(request: Request, url: str):
    """Forward WHIP/WHEP SDP so the HTTPS UI can talk to http://host:8889."""
    if not _is_webrtc_signaling_url(url):
        raise HTTPException(
            status_code=400,
            detail="URL must be an http(s) WHIP or WHEP signaling endpoint.",
        )
    body = await request.body()
    content_type = request.headers.get("content-type") or "application/sdp"
    headers = {"Content-Type": content_type, "Accept-Encoding": "identity"}
    timeout = httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)
    try:
        async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
            upstream = await client.request(request.method, url, content=body, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"WebRTC signaling failed: {exc}") from exc
    out_headers = {
        "Cache-Control": "no-store",
        "Access-Control-Expose-Headers": "Location, ETag",
    }
    location = upstream.headers.get("location")
    if location:
        absolute = urljoin(url, location)
        out_headers["Location"] = f"/api/webrtc/sdp?url={quote(absolute, safe='')}"
    etag = upstream.headers.get("etag")
    if etag:
        out_headers["ETag"] = etag
    media_type = upstream.headers.get("content-type") or "application/sdp"
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=out_headers,
        media_type=media_type,
    )


@app.get("/api/playback/fetch")
async def playback_fetch(url: str, request: Request):
    url = _unwrap_nested_playback_fetch_url(url)
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Only http(s) playback URLs are allowed")
    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid playback URL")

    safe_url = _sanitize_fetch_url(url)

    # Forward any query params the player appended to the *proxy* URL onto the
    # upstream URL. This is load-bearing for LL-HLS: hls.js appends
    # _HLS_msn/_HLS_part/_HLS_skip to the (rewritten, proxied) playlist URL to
    # request a *blocking* reload — "hold this response until that part
    # exists". Dropping them made MediaMTX answer instantly with a stale
    # playlist, so hls.js got older data than it asked for, thrashed duplicate
    # part loads, and stalled (root cause of the frozen/stuttering SRT leg —
    # direct-to-MediaMTX playback with identical player config was flawless,
    # 2026-07-21).
    extra_params = [
        (key, value)
        for key, value in request.query_params.multi_items()
        if key != "url"
    ]
    if extra_params:
        joiner = "&" if urlparse(safe_url).query else "?"
        safe_url = safe_url + joiner + urlencode(extra_params)
    path_lower = (parsed.path or "").lower()
    likely_m3u8 = path_lower.endswith(".m3u8") or "m3u8" in path_lower
    likely_mpd = path_lower.endswith(".mpd") or ".mpd" in path_lower
    likely_manifest = likely_m3u8 or likely_mpd
    # Zixi long-polls live playlists until the next segment (~chunk duration,
    # min 2s), and MediaMTX holds LL-HLS blocking reloads until the requested
    # part exists (~part duration). Keep the manifest deadline tight and well
    # under hls.js's own manifestLoadingTimeOut (10s) so a slow poll surfaces
    # as a fast retry, not a client-side fatal timeout race. On timeout return
    # a real error so hls.js retries and keeps its previous playlist — do NOT
    # return an empty #EXTM3U here, that replaces a valid live playlist and
    # kills playback.
    manifest_timeout = httpx.Timeout(connect=5.0, read=5.0, write=5.0, pool=10.0)
    no_store = {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
    }
    client = _get_playback_client()

    # Propagate upstream 404 so waitForManifest / hls.js can keep polling without
    # replacing a live playlist with an empty #EXTM3U stub (that causes fatal
    # levelParsingError with http=200 once the Zixi input is torn down).
    if likely_manifest:
        try:
            upstream = await client.get(safe_url, timeout=manifest_timeout)
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=504, detail=PLAYBACK_FETCH_TIMED_OUT) from exc
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Playback fetch failed: {exc}") from exc
        if upstream.status_code >= 400:
            raise HTTPException(
                status_code=upstream.status_code,
                detail=f"Playback upstream error: HTTP {upstream.status_code}",
            )
        media_type = upstream.headers.get("Content-Type", "application/octet-stream")
        content = upstream.content
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
        return Response(content=content, media_type=media_type, headers=no_store)

    # Media (TS chunks, fMP4 parts, continuous HTTP-TS): stream — buffering the
    # full body added multi-hundred-ms TTFF, and HTTP-TS bodies never end.
    upstream_request = client.build_request("GET", safe_url)
    try:
        upstream = await client.send(upstream_request, stream=True)
    except httpx.TimeoutException as exc:
        raise HTTPException(status_code=504, detail=PLAYBACK_FETCH_TIMED_OUT) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Playback fetch failed: {exc}") from exc
    if upstream.status_code >= 400:
        await upstream.aclose()
        raise HTTPException(
            status_code=upstream.status_code,
            detail=f"Playback upstream error: HTTP {upstream.status_code}",
        )
    media_type = upstream.headers.get("Content-Type", "application/octet-stream")

    # Parity with the old sync proxy: a playlist served from a URL that
    # doesn't look like one (no "m3u8"/".mpd" in the path) is detected by
    # response content-type and still gets its URLs rewritten.
    lowered = media_type.lower()
    if "mpegurl" in lowered or "m3u8" in lowered or "dash+xml" in lowered:
        try:
            content = await upstream.aread()
        finally:
            await upstream.aclose()
        if "dash+xml" in lowered and _is_mpd_manifest(url, media_type, content):
            content = _rewrite_mpd_manifest(url, content)
            return Response(content=content, media_type="application/dash+xml", headers=no_store)
        if _is_m3u8_manifest(url, media_type, content):
            content = _rewrite_m3u8_manifest(url, content)
            media_type = "application/vnd.apple.mpegurl"
        return Response(content=content, media_type=media_type, headers=no_store)

    # Live HTTP-TS: origin may send 200 + INT64_MAX / no Content-Length and
    # then never emit a TS byte. Peek the first chunk so the player sees
    # "answered but idle" instead of collapsing to host-down "signal timed out".
    if is_live_http_ts(parsed.path or "", upstream.headers):
        body_iter = upstream.aiter_bytes(64 * 1024)
        try:
            first = await asyncio.wait_for(body_iter.__anext__(), timeout=_HTTP_TS_FIRST_BYTE_SEC)
        except StopAsyncIteration:
            first = b""
        except (asyncio.TimeoutError, httpx.TimeoutException):
            await upstream.aclose()
            return playback_fetch_idle_response(upstream.status_code)
        if not first:
            await upstream.aclose()
            return playback_fetch_idle_response(upstream.status_code)

        async def iter_first_then_rest():
            try:
                yield first
                async for chunk in body_iter:
                    yield chunk
            except httpx.HTTPError:
                pass
            finally:
                await upstream.aclose()

        return StreamingResponse(iter_first_then_rest(), media_type=media_type, headers=no_store)

    async def iter_chunks():
        try:
            async for chunk in upstream.aiter_bytes(64 * 1024):
                yield chunk
        except httpx.HTTPError:
            # Upstream died mid-stream (input torn down, read timeout). End the
            # body; the player treats the short read as a reconnect signal.
            pass
        finally:
            await upstream.aclose()

    return StreamingResponse(iter_chunks(), media_type=media_type, headers=no_store)


@app.get("/api/playback/mpegts-remux")
async def playback_mpegts_remux(url: str):
    """Live remux MediaMTX HLS (the path that already plays) to MPEG-TS.

    MediaMTX has no Zixi-style http_ts_auto_out. Testers who pick MPEG-TS
    after LL-HLS works get a blank player unless we remux the same origin.
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Only http(s) HLS URLs can be remuxed")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path_lower = (parsed.path or "").lower()
    if port not in {8888, 8891} and not path_lower.endswith(".m3u8"):
        raise HTTPException(
            status_code=400,
            detail="MPEG-TS remux is limited to MediaMTX HLS (port 8888) or an .m3u8 URL",
        )
    safe_url = _sanitize_fetch_url(url)
    ffmpeg = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
    if not os.path.isfile(ffmpeg):
        raise HTTPException(status_code=503, detail="ffmpeg is not installed for MPEG-TS remux")
    proc = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        safe_url,
        "-c",
        "copy",
        "-f",
        "mpegts",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    async def iter_ts():
        try:
            assert proc.stdout is not None
            while True:
                chunk = await proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.returncode is None:
                proc.kill()
                try:
                    await proc.wait()
                except ProcessLookupError:
                    pass

    return StreamingResponse(
        iter_ts(),
        media_type="video/mp2t",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


def _m3u8_capture_fields(manifest_text: str) -> dict:
    """Parse fields Zixi support asked for (media_sequence, depth, chunk URI)."""
    media_sequence = None
    target_duration = None
    segment_uris: list[str] = []
    for line in manifest_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_sequence = int(stripped.split(":", 1)[1].strip())
            except ValueError:
                media_sequence = None
        elif stripped.startswith("#EXT-X-TARGETDURATION:"):
            try:
                target_duration = float(stripped.split(":", 1)[1].strip())
            except ValueError:
                target_duration = None
        elif stripped and not stripped.startswith("#"):
            segment_uris.append(stripped)
    return {
        "media_sequence": media_sequence,
        "target_duration": target_duration,
        "playlist_depth": len(segment_uris),
        "segment_uris": segment_uris[:8],
    }


@app.get("/api/playback/probe")
def playback_probe(url: str):
    """Fetch manifest + first media segment and return structured playback diagnostics.

    Includes a vendor-friendly capture block (raw playlist + segment status/headers)
    so stuck Fast HLS cases can be emailed without a separate curl session.
    """
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
        "manifest_status": None,
        "manifest_headers": {},
        "manifest_body": None,
        "media_sequence": None,
        "target_duration": None,
        "playlist_depth": None,
        "segment_url": None,
        "segment_ok": False,
        "segment_bytes": 0,
        "segment_status": None,
        "segment_headers": {},
        "curl_playlist": f'curl -v "{safe_manifest_url}"',
        "curl_segment": None,
        "checks": [],
    }

    try:
        with urllib.request.urlopen(urllib.request.Request(safe_manifest_url, method="GET"), timeout=15) as response:
            manifest = response.read()
            result["manifest_status"] = int(getattr(response, "status", 200) or 200)
            result["manifest_headers"] = {k: v for k, v in response.headers.items()}
    except urllib.error.HTTPError as exc:
        result["manifest_status"] = int(exc.code)
        result["manifest_headers"] = {k: v for k, v in (exc.headers.items() if exc.headers else [])}
        try:
            body = exc.read()
            result["manifest_body"] = body.decode("utf-8", errors="replace")[:4000]
            result["manifest_bytes"] = len(body)
        except Exception:
            pass
        result["checks"].append(f"manifest_http_{exc.code}")
        return result
    except urllib.error.URLError as exc:
        result["checks"].append(f"manifest_fetch_failed:{exc.reason}")
        return result

    if not _is_m3u8_manifest(url, "application/vnd.apple.mpegurl", manifest):
        result["checks"].append("manifest_not_m3u8")
        return result

    manifest_text = manifest.decode("utf-8", errors="replace")
    result["manifest_ok"] = True
    result["manifest_bytes"] = len(manifest)
    result["manifest_body"] = manifest_text[:8000]
    result.update(_m3u8_capture_fields(manifest_text))

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
        for raw_line in manifest_text.splitlines():
            raw_stripped = raw_line.strip()
            if raw_stripped and not raw_stripped.startswith("#"):
                upstream_line = urljoin(url, raw_stripped)
                break
        segment_url = _sanitize_fetch_url(upstream_line)
    else:
        segment_url = _sanitize_fetch_url(urljoin(url, segment_line))

    result["segment_url"] = segment_url
    result["curl_segment"] = f'curl -v -o /tmp/zixi-chunk.ts "{segment_url}"'
    try:
        with urllib.request.urlopen(urllib.request.Request(segment_url, method="GET"), timeout=15) as response:
            segment = response.read()
            result["segment_status"] = int(getattr(response, "status", 200) or 200)
            result["segment_headers"] = {k: v for k, v in response.headers.items()}
    except urllib.error.HTTPError as exc:
        result["segment_status"] = int(exc.code)
        result["segment_headers"] = {k: v for k, v in (exc.headers.items() if exc.headers else [])}
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


from moq_relay_certs import fingerprint_for_host


@app.get("/api/moq/probe")
def moq_probe(relay_admin: str = ""):
    """Fetch moqx relay subscribe/publish metrics for playback diagnostics.

    Lifetime Prometheus totals stay in the top-level fields (backward
    compatible). ``window`` is the delta since the previous probe of this
    same admin URL — that is what ``relay_playback_broken`` uses, so a busy
    relay's historical ``track_not_exist`` count cannot fail a healthy job.

    ``relay_admin`` is required. The leftover draft-16 admin on ``:8000``
    is not a default — scraping it for a ``:14433`` job watches the other
    container and reports a false never-announced.
    """
    if not (relay_admin or "").strip():
        raise HTTPException(
            status_code=400,
            detail="relay_admin is required; leftover :8000 is not a default",
        )
    from moqx_stats import (
        fetch_moqx_metrics_body,
        interpret_moqx_probe,
        parse_moqx_metrics,
        remember_probe,
        snapshot_as_probe_dict,
        snapshot_delta,
    )

    metrics_url = f"{relay_admin.rstrip('/')}/metrics"
    result: dict = {
        "relay_admin": metrics_url,
        "reachable": False,
        "subscribe_success": None,
        "subscribe_error": None,
        "subscribe_error_track_not_exist": None,
        "publish_namespace_success": None,
        "publish_received": None,
        "publish_done": None,
        "lifetime": None,
        "window": None,
        "window_basis": "none",
        "checks": [],
    }
    body = fetch_moqx_metrics_body(metrics_url, timeout=4.0)
    if body is None:
        result["checks"].append("metrics_unreachable:timed out")
        return result

    result["reachable"] = True
    lifetime = parse_moqx_metrics(body)
    previous = remember_probe(metrics_url, lifetime)
    had_prior = previous is not None
    window = snapshot_delta(lifetime, previous) if previous is not None else lifetime
    result.update(snapshot_as_probe_dict(lifetime))
    result["lifetime"] = snapshot_as_probe_dict(lifetime)
    result["window"] = snapshot_as_probe_dict(window)
    result["window_basis"] = "since_last_probe" if had_prior else "lifetime_no_prior_probe"
    result["checks"] = interpret_moqx_probe(lifetime, window, had_prior_probe=had_prior)
    return result


@app.get("/api/moq/fingerprint")
def moq_fingerprint(relay: str):
    parsed = urlparse(relay)
    if parsed.scheme not in {"https", "http"}:
        raise HTTPException(status_code=400, detail="Relay URL must be http(s)")
    host = parsed.hostname
    if not host:
        raise HTTPException(status_code=400, detail="Invalid relay URL")

    fingerprint = fingerprint_for_host(host)
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

    result_path = ROOT_DIR / "results" / filename
    if not result_path.exists():
        raise HTTPException(status_code=404, detail="Result not found")

    # .summary.json files are already the computed summary. Running them
    # through the CSV parser returned nonsense (each raw JSON line became a
    # "row", every average read 0). Return the parsed JSON directly instead.
    if filename.endswith(".json"):
        try:
            with open(result_path, mode="r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Result JSON could not be read: {exc}",
            )
        if not isinstance(payload, dict):
            return {"filename": filename, "data": payload}
        return {"filename": filename, **payload}

    summary = read_result_summary(str(result_path))
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
        return FileResponse(
            FRONTEND_DIST / "index.html",
            headers={"Cache-Control": "no-store"},
        )
else:
    @app.get("/")
    def root():
        return {
            "message": "MoQ Test Tools API is running. Build the frontend with `npm run build` in web/frontend.",
        }
