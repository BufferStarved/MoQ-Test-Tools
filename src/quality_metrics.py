"""Quality metric schema helpers for dual encoder/ingest VMAF."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

from vmaf_score import VmafResult


def quality_leg_from_vmaf_result(
    result: Optional[VmafResult],
    *,
    status: str,
    computed_on: str,
    distorted_path: str = "",
    error: str = "",
) -> Dict[str, Any]:
    leg: Dict[str, Any] = {
        "status": status,
        "computed_on": computed_on,
    }
    if result is not None:
        leg["vmaf_score"] = result.vmaf_score
        if result.psnr_db is not None:
            leg["psnr_db"] = result.psnr_db
        if result.ssim is not None:
            leg["ssim"] = result.ssim
    if distorted_path:
        leg["distorted_path"] = distorted_path
    if error:
        leg["error"] = error
    return leg


def build_quality_payload(
    *,
    encoder: Optional[Dict[str, Any]] = None,
    ingest: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    quality: Dict[str, Any] = {}
    if encoder:
        quality["encoder"] = encoder
    if ingest:
        quality["ingest"] = ingest
    return quality


def patch_summary_quality_leg(
    summary_path: str,
    leg: str,
    leg_payload: Dict[str, Any],
    *,
    sync_averages: bool = False,
) -> None:
    """Patch one quality leg (encoder or ingest) into a summary JSON file."""
    if not os.path.exists(summary_path):
        return

    with open(summary_path, mode="r", encoding="utf-8") as handle:
        payload = json.load(handle)

    quality = payload.setdefault("quality", {})
    quality[leg] = leg_payload

    if sync_averages and leg == "ingest" and leg_payload.get("vmaf_score") is not None:
        payload.setdefault("averages", {})["vmaf_score"] = leg_payload["vmaf_score"]
        if leg_payload.get("psnr_db") is not None:
            payload["averages"]["psnr_db"] = leg_payload["psnr_db"]
        if leg_payload.get("ssim") is not None:
            payload["averages"]["ssim"] = leg_payload["ssim"]

    with open(summary_path, mode="w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
