"""Shared protocol for the local publisher agent ↔ API orchestrator.

Designed so the same agent can later point at a hosted API (WSS + token)
without changing the job payload shape.
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any, Dict, Optional

from destinations import DestinationProfile
from moq_publish import (
    MoqPublishTarget,
    ensure_zixi_srt_streamid,
    infer_moq_draft_from_url,
    moq_insecure_tls_for_endpoint,
)
from upload_service import UploadJob, UploadResult, UploadSample

PROTOCOL_VERSION = 1


def destination_to_dict(destination: DestinationProfile) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "protocol": destination.protocol,
        "url": ensure_zixi_srt_streamid(destination.url, destination.preset_id),
        "label": destination.label,
        "preset_id": destination.preset_id,
        "ingest_provider": destination.ingest_provider,
        "cloud_provider": destination.cloud_provider,
        "cloud_region": destination.cloud_region,
        "moq_target": None,
    }
    if destination.moq_target is not None:
        payload["moq_target"] = asdict(destination.moq_target)
    return payload


def destination_from_dict(data: Dict[str, Any]) -> DestinationProfile:
    moq_raw = data.get("moq_target")
    moq_target = None
    if isinstance(moq_raw, dict) and moq_raw.get("endpoint"):
        endpoint = str(moq_raw.get("endpoint") or "")
        draft_raw = moq_raw.get("draft")
        if draft_raw in (None, ""):
            draft = infer_moq_draft_from_url(endpoint)
        else:
            draft = int(draft_raw)
        moq_target = MoqPublishTarget(
            endpoint=endpoint,
            namespace=str(moq_raw.get("namespace") or "benchmark"),
            transport=str(moq_raw.get("transport") or "webtransport"),
            draft=draft,
            forward=int(moq_raw.get("forward") or 1),
            insecure_tls=moq_insecure_tls_for_endpoint(
                endpoint, bool(moq_raw.get("insecure_tls"))
            ),
        )
    preset_id = str(data.get("preset_id") or "")
    return DestinationProfile(
        protocol=str(data.get("protocol") or ""),
        url=ensure_zixi_srt_streamid(str(data.get("url") or ""), preset_id),
        label=str(data.get("label") or ""),
        preset_id=preset_id,
        ingest_provider=str(data.get("ingest_provider") or ""),
        cloud_provider=str(data.get("cloud_provider") or ""),
        cloud_region=str(data.get("cloud_region") or ""),
        moq_target=moq_target,
    )


def upload_job_to_dict(job: UploadJob) -> Dict[str, Any]:
    return {
        "protocol_version": PROTOCOL_VERSION,
        "job_id": job.job_id,
        "media_path": job.media_path,
        "duration_sec": job.duration_sec,
        "destination": destination_to_dict(job.destination),
        "comparison_id": job.comparison_id,
        "stream_index": job.stream_index,
        "stream_label": job.stream_label,
        "compute_vmaf_on_ingest": job.compute_vmaf_on_ingest,
        "compute_vmaf_encoder": job.compute_vmaf_encoder,
        "encode_ladder": job.encode_ladder,
        "target_latency_ms": job.target_latency_ms,
        "zixi_stream_id": job.zixi_stream_id,
        "zixi_playback_stream_id": job.zixi_playback_stream_id,
        "ingest_recording_dir": job.ingest_recording_dir,
        "ingest_agent_url": job.ingest_agent_url,
        "ingest_agent_token": job.ingest_agent_token,
        "publisher_host": getattr(job, "publisher_host", "local"),
        "encoder": getattr(job, "encoder", "ffmpeg") or "ffmpeg",
        "publisher_session": getattr(job, "publisher_session", "") or "",
    }


def upload_job_from_dict(data: Dict[str, Any]) -> UploadJob:
    destination = destination_from_dict(data.get("destination") or {})
    job = UploadJob(
        media_path=str(data.get("media_path") or "dummy.mp4"),
        destination=destination,
        duration_sec=int(data.get("duration_sec") or 60),
        job_id=str(data.get("job_id") or ""),
        comparison_id=str(data.get("comparison_id") or ""),
        stream_index=int(data.get("stream_index") or 0),
        stream_label=str(data.get("stream_label") or ""),
        compute_vmaf_on_ingest=bool(data.get("compute_vmaf_on_ingest")),
        compute_vmaf_encoder=bool(data.get("compute_vmaf_encoder")),
        encode_ladder=str(data.get("encode_ladder") or "720p"),
        target_latency_ms=int(data.get("target_latency_ms") or 800),
        zixi_stream_id=str(data.get("zixi_stream_id") or ""),
        zixi_playback_stream_id=str(data.get("zixi_playback_stream_id") or ""),
        ingest_recording_dir=str(data.get("ingest_recording_dir") or ""),
        ingest_agent_url=str(data.get("ingest_agent_url") or ""),
        ingest_agent_token=str(data.get("ingest_agent_token") or ""),
    )
    job.publisher_host = str(data.get("publisher_host") or "local")
    job.encoder = str(data.get("encoder") or "ffmpeg")
    job.publisher_session = str(data.get("publisher_session") or "")
    return job


def sample_to_dict(sample: UploadSample) -> Dict[str, Any]:
    if is_dataclass(sample):
        return asdict(sample)
    return dict(sample.__dict__)


def result_to_dict(result: UploadResult) -> Dict[str, Any]:
    return asdict(result) if is_dataclass(result) else {
        "success": bool(getattr(result, "success", False)),
        "csv_path": getattr(result, "csv_path", None),
        "summary_path": getattr(result, "summary_path", None),
        "error": getattr(result, "error", None),
        "encoder_vmaf_status": getattr(result, "encoder_vmaf_status", "disabled"),
        "encoder_vmaf_score": getattr(result, "encoder_vmaf_score", None),
        "encoder_psnr_db": getattr(result, "encoder_psnr_db", None),
        "encoder_ssim": getattr(result, "encoder_ssim", None),
        "encoder_vmaf_error": getattr(result, "encoder_vmaf_error", None),
        "vmaf_score": getattr(result, "vmaf_score", None),
        "psnr_db": getattr(result, "psnr_db", None),
        "ssim": getattr(result, "ssim", None),
    }


def result_from_dict(data: Optional[Dict[str, Any]]) -> UploadResult:
    payload = data or {}
    return UploadResult(
        success=bool(payload.get("success")),
        csv_path=payload.get("csv_path"),
        summary_path=payload.get("summary_path"),
        vmaf_score=payload.get("vmaf_score"),
        psnr_db=payload.get("psnr_db"),
        ssim=payload.get("ssim"),
        encoder_vmaf_status=str(payload.get("encoder_vmaf_status") or "disabled"),
        encoder_vmaf_score=payload.get("encoder_vmaf_score"),
        encoder_psnr_db=payload.get("encoder_psnr_db"),
        encoder_ssim=payload.get("encoder_ssim"),
        encoder_vmaf_error=payload.get("encoder_vmaf_error"),
        error=payload.get("error"),
    )
