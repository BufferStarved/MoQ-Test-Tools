import json
import logging
import os
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from config import FFMPEG_BIN, RECORDING_DIR, WORK_DIR

logger = logging.getLogger("ingest-agent")

# e2-medium ingest boxes wedge when libvmaf takes both cores (SSH/health die,
# the next RTMP publish gets bitrate 0). Resolve ffmpeg once; score with one
# nice'd thread and a hard cap so the agent stays reachable.
_FFMPEG_CACHE: Optional[str] = None
_FFMPEG_RESOLVED = False
VMAF_FFMPEG_TIMEOUT_SEC = 180
VMAF_N_THREADS = 1
# 9.5MB leftover Zixi captures pegged e2-medium for minutes. Eight seconds of
# each file is enough to score; skip entirely when the box is already busy.
VMAF_INPUT_CAP_SEC = 8
VMAF_LOAD_BUSY = 0.85


@dataclass
class VmafJobState:
    job_id: str
    reference_path: str = ""
    status: str = "pending"
    vmaf_score: Optional[float] = None
    psnr_db: Optional[float] = None
    ssim: Optional[float] = None
    distorted_path: str = ""
    log_path: str = ""
    error: str = ""


def job_dir(job_id: str) -> Path:
    return Path(WORK_DIR) / job_id


def reference_path_for(job_id: str, suffix: str = ".mp4") -> Path:
    return job_dir(job_id) / f"reference{suffix}"


def _resolve_ffmpeg() -> Optional[str]:
    global _FFMPEG_CACHE, _FFMPEG_RESOLVED
    if _FFMPEG_RESOLVED:
        return _FFMPEG_CACHE
    candidates = [
        FFMPEG_BIN,
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "ffmpeg",
    ]
    found = None
    for candidate in candidates:
        if not candidate:
            continue
        try:
            completed = subprocess.run(
                [candidate, "-hide_banner", "-filters"],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if "libvmaf" in (completed.stdout or "") + (completed.stderr or ""):
            found = candidate
            break
    _FFMPEG_CACHE = found
    _FFMPEG_RESOLVED = True
    return _FFMPEG_CACHE


def _parse_quality_metrics(payload: dict) -> tuple[Optional[float], Optional[float], Optional[float]]:
    pooled = payload.get("pooled_metrics", {})

    vmaf = pooled.get("vmaf")
    if isinstance(vmaf, dict):
        vmaf_score = vmaf.get("harmonic_mean", vmaf.get("mean"))
    else:
        vmaf_score = vmaf
    if vmaf_score is None:
        aggregate = payload.get("aggregate_metrics", {})
        vmaf = aggregate.get("vmaf")
        if isinstance(vmaf, dict):
            vmaf_score = vmaf.get("harmonic_mean", vmaf.get("mean"))
        else:
            vmaf_score = vmaf
    if vmaf_score is None:
        raise ValueError("vmaf score missing from libvmaf output")

    # feature=name=psnr reports the luma channel as "psnr_y" (plus psnr_cb/psnr_cr),
    # not a plain "psnr" key. Some older libvmaf builds/filter options do use "psnr"
    # directly, so fall back to that for compatibility with older logs.
    psnr_db = None
    psnr = pooled.get("psnr_y", pooled.get("psnr"))
    if isinstance(psnr, dict):
        psnr_db = psnr.get("mean", psnr.get("harmonic_mean"))
    elif psnr is not None:
        psnr_db = psnr

    # feature=name=float_ssim reports "float_ssim" (the precise floating-point
    # SSIM implementation); older/legacy ssim=1 filter options used "ssim".
    ssim = None
    ssim_metric = pooled.get("float_ssim", pooled.get("ssim"))
    if isinstance(ssim_metric, dict):
        ssim = ssim_metric.get("mean", ssim_metric.get("harmonic_mean"))
    elif ssim_metric is not None:
        ssim = ssim_metric

    return (
        round(float(vmaf_score), 3),
        round(float(psnr_db), 3) if psnr_db is not None else None,
        round(float(ssim), 4) if ssim is not None else None,
    )


def _parse_vmaf_score(payload: dict) -> float:
    vmaf_score, _, _ = _parse_quality_metrics(payload)
    return vmaf_score


def distorted_recording_path(job_id: str, recording_dir: str = "") -> Path:
    root = Path(recording_dir or RECORDING_DIR)
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{job_id}.mp4"


def _looks_like_annex_b(path: Path) -> bool:
    name = path.name.lower()
    if name.endswith((".h264", ".264", ".annexb")):
        return True
    try:
        with path.open("rb") as handle:
            head = handle.read(8)
    except OSError:
        return False
    if len(head) < 4:
        return False
    return head[:4] == b"\x00\x00\x00\x01" or head[:3] == b"\x00\x00\x01"


def _host_too_busy(threshold: float = VMAF_LOAD_BUSY) -> bool:
    try:
        load1 = os.getloadavg()[0]
    except (OSError, AttributeError):
        return False
    cpus = os.cpu_count() or 1
    return load1 >= max(1.2, cpus * threshold)


def _ffmpeg_input_args(path: str) -> list[str]:
    prefix = ["-t", str(VMAF_INPUT_CAP_SEC)]
    if _looks_like_annex_b(Path(path)):
        return ["-f", "h264", "-framerate", "30", *prefix, "-i", path]
    return [*prefix, "-i", path]


def find_distorted_recording(
    start_epoch: float,
    end_epoch: float,
    recording_dir: str = "",
    job_id: str = "",
) -> Optional[str]:
    if job_id:
        captured = job_dir(job_id) / "http-ts-capture.ts"
        if captured.is_file() and captured.stat().st_size >= 188:
            return str(captured)

    root = recording_dir or RECORDING_DIR
    if not os.path.isdir(root):
        return None

    if job_id:
        explicit = Path(root) / f"{job_id}.mp4"
        if explicit.is_file() and explicit.stat().st_size > 0:
            return str(explicit)
        # Zixi's ingest_recording_dir is the Broadcaster install tree, not a
        # recordings folder. Walking it picks up unrelated .ts/.mp4 files.
        if Path(root).name in {"zixi_broadcaster-linux64", "zixi_broadcaster"}:
            return None

    extensions = ("*.ts", "*.mp4", "*.mkv", "*.m2ts")
    candidates: list[tuple[float, str]] = []

    for ext in extensions:
        for path in Path(root).rglob(ext):
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size <= 0:
                continue
            if stat.st_mtime >= start_epoch - 5 and stat.st_mtime <= end_epoch + 300:
                candidates.append((stat.st_mtime, str(path)))

    if candidates:
        candidates.sort(reverse=True)
        return candidates[0][1]
    return None


def compute_vmaf(
    job_id: str,
    start_epoch: float,
    end_epoch: float,
    recording_dir: str = "",
    http_ts_url: str = "",
) -> VmafJobState:
    state = VmafJobState(job_id=job_id, status="computing")

    from recording_service import get_recording_state, recording_has_media

    captured_already = job_dir(job_id) / "http-ts-capture.ts"
    recording = None if captured_already.is_file() else get_recording_state(job_id)
    if recording is not None:
        for _ in range(180):
            recording = get_recording_state(job_id)
            if recording is None or recording.status in {"completed", "failed"}:
                break
            time.sleep(2)
        if recording and recording.status == "failed" and recording.error:
            distorted_guess = distorted_recording_path(job_id, recording_dir)
            if not recording_has_media(distorted_guess):
                state.status = "failed"
                state.error = recording.error
                return state

    reference = None
    for candidate in job_dir(job_id).glob("reference*"):
        if candidate.is_file():
            reference = candidate
            break

    if reference is None:
        state.status = "failed"
        state.error = "Reference media not uploaded for this job"
        return state

    state.reference_path = str(reference)
    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        state.status = "failed"
        state.error = "ffmpeg with libvmaf is not available on this ingest host"
        return state

    distorted = find_distorted_recording(
        start_epoch,
        end_epoch,
        recording_dir=recording_dir,
        job_id=job_id,
    )
    if not distorted:
        for attempt in range(2):
            time.sleep(1)
            distorted = find_distorted_recording(
                start_epoch,
                end_epoch,
                recording_dir=recording_dir,
                job_id=job_id,
            )
            if distorted:
                break
    if not distorted:
        # Post-job HTTP-TS pulls return empty 200 once the publisher stops and
        # ffmpeg long-polls :7777 until it wedges the ingest agent (2026-08-26
        # Zixi RTMP: health timed out, IAP SSH died, VMAF stayed "computing").
        # Capture during the job via ts_capture.py; do not pull after the fact.
        _ = http_ts_url  # reserved for callers that already captured
        state.status = "failed"
        state.error = (
            "No during-job capture (http-ts-capture.ts or MoQ recording) "
            f"under {recording_dir or RECORDING_DIR}. "
            "Zixi ingest VMAF must start HTTP-TS capture while the push is live."
        )
        return state

    state.distorted_path = distorted
    if _host_too_busy():
        state.status = "failed"
        state.error = (
            "ingest host load too high for libvmaf; encode and playback still stand"
        )
        return state
    log_path = job_dir(job_id) / f"vmaf-{Path(distorted).name}.json"
    state.log_path = str(log_path)

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        *_ffmpeg_input_args(distorted),
        *_ffmpeg_input_args(str(reference)),
        "-lavfi",
        (
            "[0:v]setpts=PTS-STARTPTS[dis];"
            "[1:v]setpts=PTS-STARTPTS[ref];"
            "[dis][ref]scale2ref[dis2][ref2];"
            f"[dis2][ref2]libvmaf=log_fmt=json:log_path={log_path}:n_threads={VMAF_N_THREADS}:"
            "feature=name=psnr|name=float_ssim"
        ),
        "-f",
        "null",
        "-",
    ]

    def _nice_child() -> None:
        try:
            os.nice(15)
        except OSError:
            pass

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=VMAF_FFMPEG_TIMEOUT_SEC,
            check=False,
            preexec_fn=_nice_child,
        )
    except subprocess.TimeoutExpired:
        state.status = "failed"
        state.error = (
            f"libvmaf exceeded {VMAF_FFMPEG_TIMEOUT_SEC}s on this ingest host; "
            "encode and playback still stand"
        )
        return state
    except (OSError, subprocess.SubprocessError) as exc:
        state.status = "failed"
        state.error = f"ffmpeg libvmaf failed: {exc}"
        return state

    if completed.returncode != 0 or not log_path.exists():
        detail = (completed.stderr or completed.stdout or "unknown ffmpeg error").strip()
        state.status = "failed"
        state.error = detail[:500]
        return state

    try:
        with open(log_path, mode="r", encoding="utf-8") as handle:
            payload = json.load(handle)
        vmaf_score, psnr_db, ssim = _parse_quality_metrics(payload)
        state.vmaf_score = vmaf_score
        state.psnr_db = psnr_db
        state.ssim = ssim
        state.status = "completed"
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        state.status = "failed"
        state.error = f"Could not parse VMAF output: {exc}"

    return state


_state_lock = threading.Lock()
_vmaf_states: dict[str, VmafJobState] = {}
_vmaf_running: set[str] = set()


def get_vmaf_state(job_id: str) -> Optional[VmafJobState]:
    with _state_lock:
        return _vmaf_states.get(job_id)


def start_compute_vmaf(
    job_id: str,
    start_epoch: float,
    end_epoch: float,
    recording_dir: str = "",
    http_ts_url: str = "",
) -> VmafJobState:
    """Return immediately; libvmaf runs in a nice'd thread so /health stays up.

    A blocking POST used to hold the only uvicorn worker until ffmpeg finished
    or the web client's 240s timeout fired (`Ingest agent unreachable … timed
    out` on Zixi 2026-08-26) and pegged the e2-medium.
    """
    with _state_lock:
        existing = _vmaf_states.get(job_id)
        if existing and existing.status == "computing":
            return existing
        if existing and existing.status in {"completed", "failed"}:
            return existing
        if job_id in _vmaf_running:
            return existing or VmafJobState(job_id=job_id, status="computing")
        state = VmafJobState(job_id=job_id, status="computing")
        _vmaf_states[job_id] = state
        _vmaf_running.add(job_id)

    def _run() -> None:
        try:
            result = compute_vmaf(
                job_id,
                start_epoch,
                end_epoch,
                recording_dir=recording_dir,
                http_ts_url=http_ts_url,
            )
            with _state_lock:
                _vmaf_states[job_id] = result
        except Exception as exc:  # noqa: BLE001 — thread must not die silent
            logger.exception("background VMAF failed for %s", job_id)
            with _state_lock:
                _vmaf_states[job_id] = VmafJobState(
                    job_id=job_id,
                    status="failed",
                    error=f"background VMAF failed: {exc}",
                )
        finally:
            with _state_lock:
                _vmaf_running.discard(job_id)

    threading.Thread(target=_run, daemon=True, name=f"vmaf-{job_id[:8]}").start()
    return state
