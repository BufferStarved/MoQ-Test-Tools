import json
import logging
import os
import time
from typing import Optional

from ingest_agent_client import (
    IngestAgentClient,
    RemoteVmafResult,
    resolve_ingest_agent,
)

logger = logging.getLogger("MoQ-SRT-Bench")


from quality_metrics import patch_summary_quality_leg


def patch_summary_with_vmaf(summary_path: str, vmaf_score: float, extra: Optional[dict] = None) -> None:
    if not os.path.exists(summary_path):
        return

    ingest_leg = {
        "status": "completed",
        "computed_on": "ingest_agent",
        "vmaf_score": vmaf_score,
    }
    if extra:
        if extra.get("psnr_db") is not None:
            ingest_leg["psnr_db"] = extra["psnr_db"]
        if extra.get("ssim") is not None:
            ingest_leg["ssim"] = extra["ssim"]
        if extra.get("vmaf_distorted_path"):
            ingest_leg["distorted_path"] = extra["vmaf_distorted_path"]
        if extra.get("vmaf_reference_path"):
            ingest_leg["reference_path"] = extra["vmaf_reference_path"]
        if extra.get("vmaf_log_path"):
            ingest_leg["log_path"] = extra["vmaf_log_path"]

    patch_summary_quality_leg(summary_path, "ingest", ingest_leg, sync_averages=True)

    with open(summary_path, mode="r", encoding="utf-8") as handle:
        payload = json.load(handle)

    payload.setdefault("extra", {}).update({
        "vmaf_available": True,
        "vmaf_computed_on": "ingest_agent",
        "vmaf_pending_on_ingest": False,
        **(extra or {}),
    })

    with open(summary_path, mode="w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def prepare_reference_via_agent(
    endpoint_url: str,
    job_id: str,
    media_path: str,
    *,
    agent_url: str = "",
    recording_dir: str = "",
    agent_token: str = "",
) -> Optional[str]:
    config = resolve_ingest_agent(
        endpoint_url,
        agent_url=agent_url,
        recording_dir=recording_dir,
        agent_token=agent_token,
    )
    if config is None:
        return "Ingest agent is not configured (set ingest agent token for this endpoint)"

    client = IngestAgentClient(config)
    try:
        health = client.health()
        if not health.get("libvmaf_available"):
            return "Ingest agent is up but ffmpeg libvmaf is not available on the host"
        client.upload_reference(job_id, media_path)
    except RuntimeError as exc:
        return str(exc)
    return None


def wait_for_moq_recording_via_agent(
    endpoint_url: str,
    job_id: str,
    *,
    agent_url: str = "",
    recording_dir: str = "",
    agent_token: str = "",
    timeout_sec: int = 180,
) -> Optional[str]:
    """Block until the ingest worker MoQ recorder finishes (or timeout)."""
    config = resolve_ingest_agent(
        endpoint_url,
        agent_url=agent_url,
        recording_dir=recording_dir,
        agent_token=agent_token,
    )
    if config is None:
        return "Ingest agent is not configured"

    client = IngestAgentClient(config)
    deadline = time.time() + timeout_sec
    last_status = ""
    while time.time() < deadline:
        payload = client.recording_status(job_id)
        if payload is None:
            return None
        last_status = str(payload.get("status") or "")
        if last_status in {"completed", "failed"}:
            if last_status == "failed":
                return payload.get("error") or "MoQ recording failed"
            return None
        time.sleep(2)
    return f"Timed out waiting for MoQ recording (last status={last_status or 'unknown'})"


def compute_vmaf_via_agent(
    endpoint_url: str,
    job_id: str,
    start_epoch: float,
    end_epoch: float,
    *,
    agent_url: str = "",
    recording_dir: str = "",
    agent_token: str = "",
) -> RemoteVmafResult:
    config = resolve_ingest_agent(
        endpoint_url,
        agent_url=agent_url,
        recording_dir=recording_dir,
        agent_token=agent_token,
    )
    if config is None:
        return RemoteVmafResult(error="Ingest agent is not configured")

    client = IngestAgentClient(config)
    wait_error = wait_for_moq_recording_via_agent(
        endpoint_url,
        job_id,
        agent_url=agent_url,
        recording_dir=recording_dir,
        agent_token=agent_token,
    )
    if wait_error:
        return RemoteVmafResult(error=wait_error)
    try:
        return client.compute_vmaf(job_id, start_epoch, end_epoch)
    except RuntimeError as exc:
        return RemoteVmafResult(error=str(exc))


def start_moq_recording_via_agent(
    endpoint_url: str,
    job_id: str,
    *,
    namespace: str,
    duration_sec: int,
    agent_url: str = "",
    recording_dir: str = "",
    agent_token: str = "",
    relay_url: str = "",
) -> Optional[str]:
    config = resolve_ingest_agent(
        endpoint_url,
        agent_url=agent_url,
        recording_dir=recording_dir,
        agent_token=agent_token,
    )
    if config is None:
        return "Ingest agent is not configured (set ingest agent token for this endpoint)"

    client = IngestAgentClient(config)
    try:
        health = client.health()
        if not health.get("moq_recorder_available"):
            return (
                "MoQ recorder is not available on the ingest worker "
                f"({health.get('moq_recorder_runtime_error') or health.get('moq_recorder_bin', 'missing binary')})"
            )
        client.start_moq_recording(
            job_id,
            namespace=namespace,
            duration_sec=duration_sec,
            relay_url=relay_url,
        )
    except RuntimeError as exc:
        return str(exc)
    return None
