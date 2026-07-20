import csv
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Optional

from remote_vmaf import (
    compute_media_health_via_agent,
    compute_vmaf_via_agent,
    patch_summary_with_vmaf,
    prepare_reference_via_agent,
    start_moq_recording_via_agent,
)
from cmaf_integrity import CmafIntegrityReport
from media_health import patch_summary_with_media_health
from playback_metrics import PLAYBACK_FIELD_NAMES, patch_summary_with_playback
from quality_metrics import patch_summary_quality_leg
from upload_service import UploadJob, UploadSample, UploadService

try:
    from publisher_hub import local_publisher_enabled, publisher_hub
except ImportError:  # pragma: no cover — unit imports without web/api on path
    local_publisher_enabled = lambda: False  # type: ignore
    publisher_hub = None  # type: ignore


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class VmafStatus(str, Enum):
    DISABLED = "disabled"
    UPLOADING_REFERENCE = "uploading_reference"
    WAITING_FOR_UPLOAD = "waiting_for_upload"
    # Encoder-side VMAF/PSNR/SSIM only runs after the job's own encode capture
    # finishes (it compares against that capture, not an uploaded reference) —
    # distinct from WAITING_FOR_UPLOAD so the UI never says "disabled" for a
    # metric the user did request, and never says "computing" before there's
    # anything to compute yet.
    WAITING_FOR_ENCODE = "waiting_for_encode"
    COMPUTING = "computing"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class UploadJobRecord:
    id: str
    status: JobStatus
    protocol: str
    endpoint_url: str
    media_path: str
    duration_sec: int
    preset_id: str = ""
    moq_namespace: Optional[str] = None
    zixi_stream_id: Optional[str] = None
    # HLS playback target — the error-concealed derived stream when available,
    # so the browser never sees the reused-packager stall Zixi diagnosed.
    # Falls back to zixi_stream_id itself when concealment isn't set up.
    zixi_playback_stream_id: Optional[str] = None
    preview_ready: bool = True
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    csv_path: Optional[str] = None
    summary_path: Optional[str] = None
    error: Optional[str] = None
    samples: List[dict] = field(default_factory=list)
    compute_vmaf_on_ingest: bool = False
    compute_vmaf_encoder: bool = False
    encode_ladder: str = ""
    target_latency_ms: Optional[int] = None
    vmaf_status: str = VmafStatus.DISABLED.value
    vmaf_score: Optional[float] = None
    psnr_db: Optional[float] = None
    ssim: Optional[float] = None
    vmaf_error: Optional[str] = None
    encoder_vmaf_status: str = VmafStatus.DISABLED.value
    encoder_vmaf_score: Optional[float] = None
    encoder_psnr_db: Optional[float] = None
    encoder_ssim: Optional[float] = None
    encoder_vmaf_error: Optional[str] = None
    started_at_epoch: Optional[float] = None
    playback_samples: List[dict] = field(default_factory=list)
    playback_engine: str = ""
    publisher_host: str = "cloud"
    cancel_event: threading.Event = field(default_factory=threading.Event)


class JobManager:
    def __init__(self):
        self._jobs: Dict[str, UploadJobRecord] = {}
        self._lock = threading.Lock()
        self._service = UploadService()

    def create_job(
        self,
        job: UploadJob,
        preset_id: str = "",
    ) -> UploadJobRecord:
        job_id = str(uuid.uuid4())
        job.job_id = job_id

        moq_namespace: Optional[str] = None
        if job.destination.protocol == "moq" and job.destination.moq_target is not None:
            from dataclasses import replace

            moq_namespace = f"bench-{job_id.replace('-', '')[:8]}"
            job.destination.moq_target = replace(
                job.destination.moq_target,
                namespace=moq_namespace,
            )

        zixi_stream_id: Optional[str] = None
        zixi_playback_stream_id: Optional[str] = None
        if job.destination.protocol == "srt":
            from moq_publish import zixi_srt_stream_id_for_preset

            # Use the shared preset stream ("SRT Test"), not per-job IDs.
            # Fresh job-* inputs advertise HLS chunk=0 that Zixi keeps answering
            # with HTTP 400 forever (segment_ready=no). Overlap is already handled
            # by UploadService's exclusive SRT ingest lock + delete/recreate reset.
            zixi_stream_id = zixi_srt_stream_id_for_preset(preset_id)
            if zixi_stream_id:
                from zixi_error_concealment import ensure_error_concealed_stream

                # Best-effort: fall back to the raw stream (today's behavior,
                # still correct via -output_ts_offset + heal) if Zixi's API is
                # unreachable or concealment isn't configured.
                zixi_playback_stream_id = (
                    ensure_error_concealed_stream(zixi_stream_id) or zixi_stream_id
                )

        from destinations import PRESET_BY_ID, ingest_settings_for_preset

        if preset_id:
            agent_url, recording_dir = ingest_settings_for_preset(preset_id)
            job.ingest_agent_url = agent_url
            job.ingest_recording_dir = recording_dir

        ingest_provider = (
            (PRESET_BY_ID.get(preset_id).ingest_provider if preset_id and PRESET_BY_ID.get(preset_id) else "")
            or job.destination.ingest_provider
            or ""
        ).strip().lower()
        # Gate browser HLS until UploadService confirms a readable segment
        # (Zixi Fast HLS or MediaMTX LL-HLS). HTTP-TS PUT presets are encode-only
        # on current Broadcaster settings — do not gate them on missing playback.
        needs_hls_preview = bool(zixi_stream_id) or ingest_provider == "gcp_mediamtx"
        preview_ready = not needs_hls_preview

        publisher_host = (getattr(job, "publisher_host", None) or "cloud").strip().lower()
        if publisher_host not in {"cloud", "local"}:
            publisher_host = "cloud"
        job.publisher_host = publisher_host

        record = UploadJobRecord(
            id=job_id,
            status=JobStatus.PENDING,
            protocol=job.destination.protocol,
            endpoint_url=job.destination.url,
            media_path=job.media_path,
            duration_sec=job.duration_sec,
            preset_id=preset_id,
            moq_namespace=moq_namespace,
            zixi_stream_id=zixi_stream_id,
            zixi_playback_stream_id=zixi_playback_stream_id,
            preview_ready=preview_ready,
            compute_vmaf_on_ingest=job.compute_vmaf_on_ingest,
            compute_vmaf_encoder=job.compute_vmaf_encoder,
            encode_ladder=job.encode_ladder,
            target_latency_ms=job.target_latency_ms,
            publisher_host=publisher_host,
            vmaf_status=(
                VmafStatus.WAITING_FOR_UPLOAD.value
                if job.compute_vmaf_on_ingest
                else VmafStatus.DISABLED.value
            ),
            encoder_vmaf_status=(
                VmafStatus.WAITING_FOR_ENCODE.value
                if job.compute_vmaf_encoder
                else VmafStatus.DISABLED.value
            ),
        )
        job.cancel_event = record.cancel_event
        job.zixi_stream_id = zixi_stream_id or ""
        job.zixi_playback_stream_id = zixi_playback_stream_id or ""
        job.on_preview_ready = lambda ready, _job_id=job_id: self._update(
            _job_id, preview_ready=bool(ready)
        )
        job.on_encoder_vmaf_status = lambda status, _job_id=job_id: self._update(
            _job_id, encoder_vmaf_status=str(status)
        )
        with self._lock:
            self._jobs[job_id] = record

        thread = threading.Thread(
            target=self._run_job,
            args=(job_id, job),
            daemon=True,
        )
        thread.start()
        return record

    def request_cancel(self, job_id: str) -> bool:
        """Signal a running job to stop at the next sample boundary."""
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return False
            record.cancel_event.set()
            return True

    def _run_job(self, job_id: str, job: UploadJob) -> None:
        started_at_epoch = time.time()
        self._update(job_id, status=JobStatus.RUNNING, started_at_epoch=started_at_epoch)
        start_epoch = started_at_epoch

        if job.compute_vmaf_on_ingest:
            self._prepare_remote_vmaf(job_id, job)

        def on_sample(sample: UploadSample) -> None:
            payload = {
                "elapsed_sec": sample.elapsed_sec,
                "encoded_bitrate_kbps": sample.encoded_bitrate_kbps,
                "fps": sample.fps,
                "fps_stability": sample.fps_stability,
                "speed": sample.speed,
                "out_time": sample.out_time,
                "cpu_percent": sample.cpu_percent,
                "memory_mb": sample.memory_mb,
                "progress": sample.progress,
                "transport_rtt_ms": sample.transport_rtt_ms,
                "transport_rtt_jitter_ms": sample.transport_rtt_jitter_ms,
                "pkt_rcv_drop": sample.pkt_rcv_drop,
                "pkt_snd_drop": sample.pkt_snd_drop,
                "pkt_snd_loss": sample.pkt_snd_loss,
                "pkt_retrans": sample.pkt_retrans,
                "pkt_fec_extra": sample.pkt_fec_extra,
                "ts_continuity_counter_errors": sample.ts_continuity_counter_errors,
                "vmaf_score": sample.vmaf_score,
                "psnr_db": sample.psnr_db,
                "ssim": sample.ssim,
                "encoder_send_rate_mbps": sample.encoder_send_rate_mbps,
                "transport_recv_rate_mbps": sample.transport_recv_rate_mbps,
                "client_memory_percent": sample.client_memory_percent,
                "client_disk_percent": sample.client_disk_percent,
                "server_cpu_percent": sample.server_cpu_percent,
                "server_memory_percent": sample.server_memory_percent,
                "server_disk_percent": sample.server_disk_percent,
                "moqx_subscribe_success": sample.moqx_subscribe_success,
                "moqx_subscribe_error": sample.moqx_subscribe_error,
                "moqx_publish_namespace_success": sample.moqx_publish_namespace_success,
                "moqx_publish_received": sample.moqx_publish_received,
                "moqx_publish_done": sample.moqx_publish_done,
                "quic_rtt_ms": sample.quic_rtt_ms,
                "quic_cwnd_bytes": sample.quic_cwnd_bytes,
                "quic_packets_lost": sample.quic_packets_lost,
            }
            for name in PLAYBACK_FIELD_NAMES:
                payload[name] = 0
            with self._lock:
                record = self._jobs.get(job_id)
                if record:
                    self._apply_playback_fields(payload, record.playback_samples)
                    record.samples.append(payload)

        if job.publisher_host == "local" and local_publisher_enabled() and publisher_hub is not None:
            result = publisher_hub.run_remote(
                job,
                on_sample=on_sample,
                on_preview_ready=job.on_preview_ready,
                on_encoder_vmaf_status=job.on_encoder_vmaf_status,
            )
        else:
            if job.publisher_host == "local" and not local_publisher_enabled():
                from upload_service import UploadResult as _UploadResult

                result = _UploadResult(
                    success=False,
                    error=(
                        "publisher_host=local requires LOCAL_PUBLISHER_ENABLED=1 "
                        "(use ./scripts/dev.sh + ./scripts/run-local-publisher.sh)."
                    ),
                )
            else:
                result = self._service.run(job, on_sample=on_sample)
        end_epoch = time.time()

        try:
            if result.success:
                self._persist_playback_metrics(job_id, result.summary_path)
                self._update(
                    job_id,
                    status=JobStatus.COMPLETED,
                    csv_path=result.csv_path,
                    summary_path=result.summary_path,
                    encoder_vmaf_status=result.encoder_vmaf_status,
                    encoder_vmaf_score=result.encoder_vmaf_score,
                    encoder_psnr_db=result.encoder_psnr_db,
                    encoder_ssim=result.encoder_ssim,
                    encoder_vmaf_error=result.encoder_vmaf_error,
                    psnr_db=result.psnr_db,
                    ssim=result.ssim,
                )
                if job.compute_vmaf_on_ingest:
                    with self._lock:
                        record = self._jobs.get(job_id)
                        ingest_already_failed = (
                            record is not None
                            and record.vmaf_status == VmafStatus.FAILED.value
                        )
                        ingest_error = record.vmaf_error if record else None
                    if ingest_already_failed and result.summary_path:
                        patch_summary_quality_leg(
                            result.summary_path,
                            "ingest",
                            {
                                "status": "failed",
                                "computed_on": "ingest_agent",
                                "error": ingest_error or "Ingest VMAF failed before upload completed",
                            },
                        )
                    elif not ingest_already_failed:
                        thread = threading.Thread(
                            target=self._compute_remote_vmaf,
                            args=(job_id, job, result.summary_path, start_epoch, end_epoch),
                            daemon=True,
                        )
                        thread.start()
            else:
                self._update(
                    job_id,
                    status=JobStatus.FAILED,
                    error=result.error or "Upload failed",
                    vmaf_status=VmafStatus.FAILED.value if job.compute_vmaf_on_ingest else VmafStatus.DISABLED.value,
                    vmaf_error=result.error if job.compute_vmaf_on_ingest else None,
                    encoder_vmaf_status=(
                        VmafStatus.FAILED.value if job.compute_vmaf_encoder else VmafStatus.DISABLED.value
                    ),
                    encoder_vmaf_error=result.error if job.compute_vmaf_encoder else None,
                )
        finally:
            # Status is already COMPLETED/FAILED so the UI flips playbackGate→ended
            # and destroys HLS before we delete the Zixi input that backs the playlist.
            self._schedule_zixi_cleanup(job)

    def _schedule_zixi_cleanup(self, job: UploadJob) -> None:
        """Delete ephemeral job-* Zixi SRT inputs after a short player teardown grace."""
        stream_id = (getattr(job, "zixi_stream_id", None) or "").strip()
        if not stream_id.startswith("job-"):
            return

        def _run() -> None:
            time.sleep(2.0)
            self._service.cleanup_zixi_srt_input_if_managed(job)

        threading.Thread(
            target=_run,
            name=f"zixi-cleanup-{getattr(job, 'job_id', 'unknown')}",
            daemon=True,
        ).start()

    def _prepare_remote_vmaf(self, job_id: str, job: UploadJob) -> None:
        self._update(job_id, vmaf_status=VmafStatus.UPLOADING_REFERENCE.value, vmaf_error=None)
        upload_error = prepare_reference_via_agent(
            job.destination.url,
            job_id,
            job.media_path,
            agent_url=job.ingest_agent_url,
            recording_dir=job.ingest_recording_dir,
        )
        if upload_error:
            self._update(job_id, vmaf_status=VmafStatus.FAILED.value, vmaf_error=upload_error)
            return

        if job.destination.protocol != "moq" or job.destination.moq_target is None:
            return

        relay_url = job.destination.moq_target.endpoint
        namespace = job.destination.moq_target.namespace
        record_error = start_moq_recording_via_agent(
            job.destination.url,
            job_id,
            namespace=namespace,
            duration_sec=job.duration_sec,
            agent_url=job.ingest_agent_url,
            recording_dir=job.ingest_recording_dir,
            relay_url=relay_url,
        )
        if record_error:
            self._update(job_id, vmaf_status=VmafStatus.FAILED.value, vmaf_error=record_error)

    def _compute_remote_vmaf(
        self,
        job_id: str,
        job: UploadJob,
        summary_path: Optional[str],
        start_epoch: float,
        end_epoch: float,
    ) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record and record.vmaf_status == VmafStatus.FAILED.value and record.vmaf_error:
                return

        self._update(job_id, vmaf_status=VmafStatus.COMPUTING.value, vmaf_error=None)
        remote_result = compute_vmaf_via_agent(
            job.destination.url,
            job_id,
            start_epoch,
            end_epoch,
            agent_url=job.ingest_agent_url,
            recording_dir=job.ingest_recording_dir,
        )

        if remote_result.error or remote_result.vmaf_score is None:
            if summary_path:
                patch_summary_quality_leg(
                    summary_path,
                    "ingest",
                    {
                        "status": "failed",
                        "computed_on": "ingest_agent",
                        "error": remote_result.error or "Ingest agent returned no VMAF score",
                    },
                )
            self._update(
                job_id,
                vmaf_status=VmafStatus.FAILED.value,
                vmaf_error=remote_result.error or "Ingest agent returned no VMAF score",
            )
            return

        if summary_path:
            patch_summary_with_vmaf(
                summary_path,
                remote_result.vmaf_score,
                extra={
                    "vmaf_distorted_path": remote_result.distorted_path,
                    "vmaf_reference_path": remote_result.reference_path,
                    "vmaf_log_path": remote_result.log_path,
                    "psnr_db": remote_result.psnr_db,
                    "ssim": remote_result.ssim,
                },
            )
            self._patch_ingest_media_health(
                job,
                job_id,
                summary_path,
                start_epoch=start_epoch,
                end_epoch=end_epoch,
                distorted_path=remote_result.distorted_path,
            )

        self._update(
            job_id,
            vmaf_status=VmafStatus.COMPLETED.value,
            vmaf_score=remote_result.vmaf_score,
            psnr_db=remote_result.psnr_db,
            ssim=remote_result.ssim,
            vmaf_error=None,
        )

    def _patch_ingest_media_health(
        self,
        job: UploadJob,
        job_id: str,
        summary_path: str,
        *,
        start_epoch: float,
        end_epoch: float,
        distorted_path: str = "",
    ) -> None:
        """Prefer post-relay CMAF Media Health from the ingest recording when available."""
        if job.destination.protocol != "moq":
            return
        payload = compute_media_health_via_agent(
            job.destination.url,
            job_id,
            start_epoch=start_epoch,
            end_epoch=end_epoch,
            agent_url=job.ingest_agent_url,
            recording_dir=job.ingest_recording_dir,
            output_path=distorted_path,
        )
        if not payload:
            return
        report = CmafIntegrityReport(
            path=str(payload.get("source_path") or distorted_path or ""),
            fragment_count=int(payload.get("cmaf_fragment_count") or 0),
            seq_gap_count=int(payload.get("cmaf_seq_gap_count") or 0),
            tfdt_gap_count=int(payload.get("cmaf_tfdt_gap_count") or 0),
            tfdt_gap_ms_total=float(payload.get("cmaf_tfdt_gap_ms") or 0),
            tfdt_overlap_count=int(payload.get("cmaf_tfdt_overlap_count") or 0),
            parse_errors=int(payload.get("cmaf_parse_errors") or 0),
            timescale=int(payload.get("cmaf_timescale") or 0),
            error=str(payload.get("error") or ""),
        )
        # Rebuild a single final sample bucket so CSV gets ingest totals.
        if report.fragment_count > 0:
            report.events = []
        patch_summary_with_media_health(
            summary_path,
            report,
            computed_on="ingest_recording",
        )

    def record_playback_sample(self, job_id: str, sample: dict) -> bool:
        try:
            elapsed_sec = int(sample.get("elapsed_sec", -1))
        except (TypeError, ValueError):
            return False
        if elapsed_sec < 0:
            return False

        engine = str(sample.get("engine", "") or "").strip().lower()
        payload = {"elapsed_sec": elapsed_sec}
        for name in PLAYBACK_FIELD_NAMES:
            try:
                payload[name] = sample.get(name, 0)
            except (TypeError, ValueError):
                payload[name] = 0

        with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                return False
            record.playback_samples.append(payload)
            if engine:
                record.playback_engine = engine
            for live_sample in record.samples:
                if live_sample.get("elapsed_sec") == elapsed_sec:
                    for name in PLAYBACK_FIELD_NAMES:
                        live_sample[name] = payload[name]
        return True

    @staticmethod
    def _apply_playback_fields(payload: dict, playback_samples: List[dict]) -> None:
        if not playback_samples:
            return
        elapsed = payload.get("elapsed_sec")
        matched = next(
            (sample for sample in reversed(playback_samples) if sample.get("elapsed_sec") == elapsed),
            None,
        )
        if matched is None:
            matched = playback_samples[-1]
        for name in PLAYBACK_FIELD_NAMES:
            payload[name] = matched.get(name, 0)

    def _persist_playback_metrics(self, job_id: str, summary_path: Optional[str]) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record or not record.playback_samples or not summary_path:
                return
            playback_samples = list(record.playback_samples)
            playback_engine = record.playback_engine

        patch_summary_with_playback(
            summary_path,
            playback_samples,
            playback_engine=playback_engine,
        )

    def _update(self, job_id: str, **fields) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                return
            for key, value in fields.items():
                setattr(record, key, value)

    def get_job(self, job_id: str) -> Optional[UploadJobRecord]:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                return None
            return UploadJobRecord(
                id=record.id,
                status=record.status,
                protocol=record.protocol,
                endpoint_url=record.endpoint_url,
                media_path=record.media_path,
                duration_sec=record.duration_sec,
                preset_id=record.preset_id,
                moq_namespace=record.moq_namespace,
                zixi_stream_id=record.zixi_stream_id,
                zixi_playback_stream_id=record.zixi_playback_stream_id,
                preview_ready=record.preview_ready,
                created_at=record.created_at,
                csv_path=record.csv_path,
                summary_path=record.summary_path,
                error=record.error,
                samples=list(record.samples),
                compute_vmaf_on_ingest=record.compute_vmaf_on_ingest,
                compute_vmaf_encoder=record.compute_vmaf_encoder,
                encode_ladder=record.encode_ladder,
                target_latency_ms=record.target_latency_ms,
                publisher_host=record.publisher_host,
                vmaf_status=record.vmaf_status,
                vmaf_score=record.vmaf_score,
                psnr_db=record.psnr_db,
                ssim=record.ssim,
                vmaf_error=record.vmaf_error,
                encoder_vmaf_status=record.encoder_vmaf_status,
                encoder_vmaf_score=record.encoder_vmaf_score,
                encoder_psnr_db=record.encoder_psnr_db,
                encoder_ssim=record.encoder_ssim,
                encoder_vmaf_error=record.encoder_vmaf_error,
                started_at_epoch=record.started_at_epoch,
                playback_samples=list(record.playback_samples),
                playback_engine=record.playback_engine,
            )

    def list_jobs(self) -> List[UploadJobRecord]:
        with self._lock:
            return [
                UploadJobRecord(
                    id=record.id,
                    status=record.status,
                    protocol=record.protocol,
                    endpoint_url=record.endpoint_url,
                    media_path=record.media_path,
                    duration_sec=record.duration_sec,
                    preset_id=record.preset_id,
                    moq_namespace=record.moq_namespace,
                    zixi_stream_id=record.zixi_stream_id,
                    zixi_playback_stream_id=record.zixi_playback_stream_id,
                    preview_ready=record.preview_ready,
                    created_at=record.created_at,
                    csv_path=record.csv_path,
                    summary_path=record.summary_path,
                    error=record.error,
                    samples=[],
                    encode_ladder=record.encode_ladder,
                    target_latency_ms=record.target_latency_ms,
                    publisher_host=record.publisher_host,
                    compute_vmaf_on_ingest=record.compute_vmaf_on_ingest,
                    compute_vmaf_encoder=record.compute_vmaf_encoder,
                    vmaf_status=record.vmaf_status,
                    vmaf_score=record.vmaf_score,
                    psnr_db=record.psnr_db,
                    ssim=record.ssim,
                    vmaf_error=record.vmaf_error,
                    encoder_vmaf_status=record.encoder_vmaf_status,
                    encoder_vmaf_score=record.encoder_vmaf_score,
                    encoder_psnr_db=record.encoder_psnr_db,
                    encoder_ssim=record.encoder_ssim,
                    encoder_vmaf_error=record.encoder_vmaf_error,
                )
                for record in self._jobs.values()
            ]


def list_result_files(results_dir: str = "results") -> List[dict]:
    if not os.path.isdir(results_dir):
        return []

    files = []
    for name in os.listdir(results_dir):
        if not name.endswith(".csv"):
            continue
        path = os.path.join(results_dir, name)
        comparison_id = ""
        stream_index = 0
        protocol = ""
        stream_label = ""
        base, _ = os.path.splitext(path)
        summary_path = f"{base}.summary.json"
        if os.path.exists(summary_path):
            try:
                with open(summary_path, mode="r", encoding="utf-8") as handle:
                    summary_payload = json.load(handle)
                extra = summary_payload.get("extra", {})
                comparison_id = extra.get("comparison_id", "") or ""
                stream_index = int(extra.get("stream_index", 0) or 0)
                protocol = summary_payload.get("protocol", "") or ""
                stream_label = extra.get("stream_label", "") or ""
            except (json.JSONDecodeError, OSError, TypeError, ValueError):
                pass
        files.append({
            "filename": name,
            "path": path,
            "modified_at": datetime.fromtimestamp(
                os.path.getmtime(path), tz=timezone.utc
            ).isoformat(),
            "size_bytes": os.path.getsize(path),
            "comparison_id": comparison_id,
            "protocol": protocol,
            "stream_label": stream_label,
            "stream_index": stream_index,
        })
    files.sort(key=lambda item: item["modified_at"], reverse=True)
    return files


_LEGACY_CSV_COLUMNS = {
    "encoded_bitrate_kbps": "bitrate_kbps",
    "encoder_send_rate_mbps": "mbps_send_rate",
    "transport_recv_rate_mbps": "mbps_recv_rate",
    "transport_rtt_ms": "rtt_ms",
    "transport_rtt_jitter_ms": "rtt_jitter_ms",
    "ts_continuity_counter_errors": "cc_errors",
}


def _row_value(row: dict, key: str) -> float:
    value = row.get(key)
    if value not in (None, ""):
        return float(value or 0)
    legacy = _LEGACY_CSV_COLUMNS.get(key)
    if legacy:
        return float(row.get(legacy, 0) or 0)
    return 0.0


def read_result_summary(csv_path: str) -> dict:
    rows = []
    with open(csv_path, mode="r") as file:
        reader = csv.DictReader(file)
        for row in reader:
            rows.append(row)

    if not rows:
        return {"samples": 0, "averages": {}}

    count = len(rows)
    numeric_keys = [
        "cpu_percent",
        "memory_mb",
        "client_memory_percent",
        "client_disk_percent",
        "server_cpu_percent",
        "server_memory_percent",
        "server_disk_percent",
        "encoded_bitrate_kbps",
        "encoder_send_rate_mbps",
        "transport_recv_rate_mbps",
        "fps",
        "fps_stability",
        "speed",
        "encode_lag_ms",
        "transport_rtt_ms",
        "transport_rtt_jitter_ms",
        "quic_rtt_ms",
        "quic_cwnd_bytes",
        "playback_bitrate_bps",
        "playback_ttff_ms",
        "playback_video_time_sec",
        "playback_buffer_sec",
        "e2e_latency_ms",
        "psnr_db",
        "ssim",
    ]
    averages = {
        key: round(sum(_row_value(r, key) for r in rows) / count, 3)
        for key in numeric_keys
    }

    counter_keys = (
        "pkt_rcv_drop",
        "pkt_snd_drop",
        "pkt_snd_loss",
        "pkt_retrans",
        "pkt_fec_extra",
        "ts_continuity_counter_errors",
        "cmaf_fragment_count",
        "cmaf_seq_gap_count",
        "cmaf_tfdt_gap_count",
        "cmaf_tfdt_overlap_count",
        "cmaf_parse_errors",
        "moqx_subscribe_success",
        "moqx_subscribe_error",
        "moqx_publish_namespace_success",
        "moqx_publish_received",
        "moqx_publish_done",
        "quic_packets_lost",
        "playback_stats_events",
        "playback_stall_count",
        "playback_frames_rendered",
        "playback_frames_dropped",
        "playback_hls_errors",
        "playback_hls_fatal_errors",
        "playback_hls_buffer_stalls",
        "playback_hls_frag_loads",
        "playback_error_count",
    )
    for key in counter_keys:
        legacy = _LEGACY_CSV_COLUMNS.get(key)
        if key in rows[-1] or (legacy and legacy in rows[-1]):
            averages[key] = int(_row_value(rows[-1], key))

    # Cumulative seconds (not a plain count) — keep sub-second precision.
    if "playback_rebuffer_sec" in rows[-1]:
        averages["playback_rebuffer_sec"] = round(_row_value(rows[-1], "playback_rebuffer_sec"), 3)

    e2e_values = [
        float(r["e2e_latency_ms"])
        for r in rows
        if r.get("e2e_latency_ms") not in (None, "", "0", "0.0")
    ]
    if e2e_values:
        averages["e2e_latency_ms"] = round(sum(e2e_values) / len(e2e_values), 1)
        averages["e2e_latency_max_ms"] = round(max(e2e_values), 1)

    vmaf_values = [float(r["vmaf_score"]) for r in rows if r.get("vmaf_score")]
    if vmaf_values:
        averages["vmaf_score"] = round(vmaf_values[-1], 3)

    summary_extra = {}
    throughput = {}
    quality = {}
    base, _ = os.path.splitext(csv_path)
    summary_path = f"{base}.summary.json"
    if os.path.exists(summary_path):
        with open(summary_path, mode="r", encoding="utf-8") as handle:
            summary_payload = json.load(handle)
        summary_extra = summary_payload.get("extra", {})
        throughput = summary_payload.get("throughput", {})
        quality = summary_payload.get("quality", {})
        summary_averages = summary_payload.get("averages", {})
        for key in (
            "vmaf_score",
            "psnr_db",
            "ssim",
            "encode_lag_ms",
            "e2e_latency_ms",
            "fps_stability",
            "cmaf_fragment_count",
            "cmaf_seq_gap_count",
            "cmaf_tfdt_gap_count",
            "cmaf_parse_errors",
            "ts_continuity_counter_errors",
        ):
            if summary_averages.get(key) is not None:
                averages[key] = summary_averages[key]

        # Prefer quality legs when CSV averages are empty/zero (common for post-run VMAF).
        for leg_name in ("ingest", "encoder"):
            leg = quality.get(leg_name) or {}
            if averages.get("vmaf_score") in (None, 0, 0.0) and leg.get("vmaf_score") is not None:
                averages["vmaf_score"] = leg["vmaf_score"]
            if averages.get("psnr_db") in (None, 0, 0.0) and leg.get("psnr_db") is not None:
                averages["psnr_db"] = leg["psnr_db"]
            if averages.get("ssim") in (None, 0, 0.0) and leg.get("ssim") is not None:
                averages["ssim"] = leg["ssim"]

    return {
        "samples": count,
        "protocol": rows[0].get("protocol", ""),
        "endpoint": rows[0].get("endpoint", ""),
        "averages": averages,
        "throughput": throughput,
        "rows": rows,
        "summary_extra": summary_extra,
        "quality": quality,
    }
