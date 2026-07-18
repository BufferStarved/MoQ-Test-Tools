import json
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from config import FFMPEG_BIN, RECORDING_DIR, WORK_DIR

logger = logging.getLogger("ingest-agent")


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
    candidates = [
        FFMPEG_BIN,
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        "ffmpeg",
    ]
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
            return candidate
    return None


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


def find_distorted_recording(
    start_epoch: float,
    end_epoch: float,
    recording_dir: str = "",
    job_id: str = "",
) -> Optional[str]:
    root = recording_dir or RECORDING_DIR
    if not os.path.isdir(root):
        return None

    if job_id:
        explicit = Path(root) / f"{job_id}.mp4"
        if explicit.is_file() and explicit.stat().st_size > 0:
            return str(explicit)

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
) -> VmafJobState:
    state = VmafJobState(job_id=job_id, status="computing")

    from recording_service import get_recording_state

    recording = get_recording_state(job_id)
    if recording is not None:
        for _ in range(180):
            recording = get_recording_state(job_id)
            if recording is None or recording.status in {"completed", "failed"}:
                break
            time.sleep(2)
        if recording and recording.status == "failed" and recording.error:
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

    distorted = None
    for attempt in range(12):
        distorted = find_distorted_recording(
            start_epoch,
            end_epoch,
            recording_dir=recording_dir,
            job_id=job_id,
        )
        if distorted:
            break
        time.sleep(5)
    if not distorted:
        # Prefer disk recordings; fall back to Zixi raw HTTP-TS (http_ts_auto_out).
        http_ts = (os.environ.get("ZIXI_HTTP_TS_URL") or "").strip()
        if not http_ts:
            stream = (os.environ.get("ZIXI_HTTP_TS_STREAM") or "SRT Test").strip()
            host = (os.environ.get("ZIXI_HTTP_TS_HOST") or "127.0.0.1").strip()
            port = (os.environ.get("ZIXI_HTTP_TS_PORT") or "7777").strip()
            from urllib.parse import quote

            http_ts = f"http://{host}:{port}/{quote(stream, safe='')}.ts"
        pull_secs = max(5, int(max(0.0, end_epoch - start_epoch)) or 15)
        pulled = job_dir(job_id) / "http-ts-capture.ts"
        pull_cmd = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            http_ts,
            "-t",
            str(pull_secs),
            "-c",
            "copy",
            str(pulled),
        ]
        try:
            pull = subprocess.run(
                pull_cmd,
                capture_output=True,
                text=True,
                timeout=max(60, pull_secs + 30),
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            state.status = "failed"
            state.error = (
                f"No recording under {recording_dir or RECORDING_DIR} "
                f"and HTTP-TS pull failed: {exc}"
            )
            return state
        if pull.returncode != 0 or not pulled.is_file() or pulled.stat().st_size < 188:
            state.status = "failed"
            state.error = (
                f"No recording under {recording_dir or RECORDING_DIR} "
                f"and HTTP-TS pull from {http_ts} failed"
            )
            return state
        distorted = str(pulled)

    state.distorted_path = distorted
    log_path = job_dir(job_id) / f"vmaf-{Path(distorted).name}.json"
    state.log_path = str(log_path)

    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        distorted,
        "-i",
        str(reference),
        "-lavfi",
        (
            f"libvmaf=log_fmt=json:log_path={log_path}:n_threads=4:"
            "feature=name=psnr|name=float_ssim"
        ),
        "-f",
        "null",
        "-",
    ]

    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=900,
            check=False,
        )
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
