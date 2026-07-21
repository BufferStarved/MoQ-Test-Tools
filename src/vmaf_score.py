import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("MoQ-SRT-Bench")

LIBVMAF_FILTER_FEATURES = "feature=name=psnr|name=float_ssim"


def libvmaf_available(ffmpeg_bin: str = "ffmpeg") -> bool:
    """Return True when ffmpeg exposes the libvmaf filter."""
    try:
        result = subprocess.run(
            [ffmpeg_bin, "-hide_banner", "-filters"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False

    output = f"{result.stdout}\n{result.stderr}"
    return "libvmaf" in output


@dataclass(frozen=True)
class VmafResult:
    vmaf_score: float
    psnr_db: Optional[float] = None
    ssim: Optional[float] = None


def _parse_quality_metrics(payload: dict) -> VmafResult:
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

    psnr_db = None
    psnr = pooled.get("psnr_y", pooled.get("psnr"))
    if isinstance(psnr, dict):
        psnr_db = psnr.get("mean", psnr.get("harmonic_mean"))
    elif psnr is not None:
        psnr_db = psnr

    ssim = None
    ssim_metric = pooled.get("float_ssim", pooled.get("ssim"))
    if isinstance(ssim_metric, dict):
        ssim = ssim_metric.get("mean", ssim_metric.get("harmonic_mean"))
    elif ssim_metric is not None:
        ssim = ssim_metric

    return VmafResult(
        vmaf_score=round(float(vmaf_score), 3),
        psnr_db=round(float(psnr_db), 3) if psnr_db is not None else None,
        ssim=round(float(ssim), 4) if ssim is not None else None,
    )


def compute_vmaf(
    reference_path: str,
    distorted_path: str,
    ffmpeg_bin: str = "ffmpeg",
) -> Optional[VmafResult]:
    """Compare reference and received recordings with ffmpeg libvmaf."""
    if not os.path.exists(reference_path):
        logger.warning("VMAF reference file not found: %s", reference_path)
        return None
    if not os.path.exists(distorted_path):
        logger.warning("VMAF distorted file not found: %s", distorted_path)
        return None

    log_path = f"{distorted_path}.vmaf.json"
    # setpts=PTS-STARTPTS: live-source references are stream-copied mid-timeline
    # (bridge PTS continues across the session) while the distorted encode
    # restarts at 0 — libvmaf's framesync pairs frames by timestamp, so without
    # rebasing both to 0 it would never align them. Harmless for file sources
    # (both already start near 0). scale2ref upscales the distorted leg to the
    # reference geometry so lower ladder rungs (540p/360p) can be scored, per
    # standard VMAF practice.
    filter_graph = (
        "[0:v]setpts=PTS-STARTPTS[dis];"
        "[1:v]setpts=PTS-STARTPTS[ref];"
        "[dis][ref]scale2ref[dis2][ref2];"
        f"[dis2][ref2]libvmaf=log_fmt=json:log_path={log_path}:n_threads=4:"
        f"{LIBVMAF_FILTER_FEATURES}"
    )
    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        distorted_path,
        "-i",
        reference_path,
        "-lavfi",
        filter_graph,
        "-f",
        "null",
        "-",
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("VMAF calculation failed: %s", exc)
        return None

    if result.returncode != 0:
        logger.warning(
            "VMAF ffmpeg exited %s: %s",
            result.returncode,
            result.stderr.strip() or result.stdout.strip(),
        )
        return None

    if not os.path.exists(log_path):
        logger.warning("VMAF log not produced at %s", log_path)
        return None

    try:
        with open(log_path, mode="r") as file:
            payload = json.load(file)
        return _parse_quality_metrics(payload)
    except (OSError, json.JSONDecodeError, TypeError, ValueError) as exc:
        logger.warning("Could not parse VMAF log: %s", exc)

    try:
        with open(log_path, mode="r") as file:
            text = file.read()
        match = re.search(r'"vmaf"\s*:\s*([0-9.]+)', text)
        if match:
            return VmafResult(vmaf_score=round(float(match.group(1)), 3))
    except OSError:
        pass

    return None
