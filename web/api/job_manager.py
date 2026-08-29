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
    prepare_reference_bytes_via_agent,
    prepare_reference_via_agent,
    start_http_ts_capture_via_agent,
    start_moq_recording_via_agent,
    stop_http_ts_capture_via_agent,
)
from cmaf_integrity import CmafIntegrityReport
from media_health import patch_summary_with_media_health
from playback_metrics import (
    PLAYBACK_FIELD_NAMES,
    PLAYBACK_NULLABLE_KEYS,
    _playback_high_water,
    _recompute_derived,
    patch_summary_with_playback,
    robust_e2e_stats,
)
from encode_profile import encode_profile_summary
from moq_publish import classify_job_exception, classify_result_error, is_device_browser_source
from moq_relay_certs import fingerprint_for_relay_url
from quality_metrics import patch_summary_quality_leg
from publisher_protocol import sample_to_dict
from cloud_encode_slots import (
    CloudEncodeSlotPool,
    encode_slot_fields,
    job_needs_cloud_encode_slot,
)
from comparison_encode_hub import (
    attach_shared_encode,
    job_can_join_shared_encode,
    release_shared_encode,
)
from upload_service import (
    UploadJob,
    UploadResult,
    UploadSample,
    UploadService,
    _is_zixi_provider,
)


def live_sample_payload(sample: UploadSample) -> dict:
    """Full UploadSample dict for live /api/uploads charts.

    A previous field whitelist dropped net_* and encode_lag_ms, so the UI
    showed zeros while MetricsCollector CSV still had encoder_send_rate_mbps
    / transport_rtt_ms. Always persist the dataclass, then alias those CSV
    names onto the chart keys.
    """
    payload = sample_to_dict(sample)
    if not payload.get("net_send_mbps") and payload.get("encoder_send_rate_mbps"):
        payload["net_send_mbps"] = payload["encoder_send_rate_mbps"]
    if not payload.get("net_recv_mbps") and payload.get("transport_recv_rate_mbps"):
        payload["net_recv_mbps"] = payload["transport_recv_rate_mbps"]
    if not payload.get("net_rtt_ms") and payload.get("transport_rtt_ms"):
        payload["net_rtt_ms"] = payload["transport_rtt_ms"]
    for name in PLAYBACK_FIELD_NAMES:
        # The startup phases default to None: on those columns a 0 asserts the
        # stage was measured and instant, so the live charts have to receive
        # the same blank the CSV carries.
        payload.setdefault(name, None if name in PLAYBACK_NULLABLE_KEYS else 0)
    return payload

try:
    from publisher_hub import local_publisher_enabled, publisher_hub
except ImportError:  # pragma: no cover — unit imports without web/api on path
    local_publisher_enabled = lambda: False  # type: ignore
    publisher_hub = None  # type: ignore


def needs_publish_preview(
    protocol: str,
    *,
    zixi_stream_id: str = "",
    ingest_provider: str = "",
) -> bool:
    """True when the browser player must wait for a live-readiness signal
    before subscribing/loading, instead of starting the instant job.status
    flips to "running".

    Zixi Fast HLS (SRT *and* RTMP ingest) and MediaMTX LL-HLS need a confirmed
    readable segment. MoQ needs a confirmed relay namespace-publish success —
    without this, MoqPlayer used to start subscribing before openmoq-publisher
    had a chance to register the namespace on a live webcam source (browser
    record -> WS -> bridge ffmpeg -> UDP tee -> per-destination encode ->
    publisher is a multi-hop chain that can take several seconds), which
    produced a near-guaranteed "no such namespace or track" refusal, a
    fixed multi-second retry wait, and — because MoQ has no reliable
    catch-up without LOC CaptureTimestamps (see moqCatchUpConfig) — a
    permanent latency floor for the rest of the session.
    """
    provider = (ingest_provider or "").strip().lower()
    return bool(zixi_stream_id) or provider.endswith("_mediamtx") or protocol == "moq"


class JobStatus(str, Enum):
    PENDING = "pending"
    QUEUED = "queued"
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
    browser_error: Optional[str] = None
    samples: List[dict] = field(default_factory=list)
    compute_vmaf_on_ingest: bool = False
    compute_vmaf_encoder: bool = False
    encode_ladder: str = ""
    target_latency_ms: Optional[int] = None
    playback_policy: str = "live-edge"
    test_scope: str = "e2e"
    ingest_agent_url: str = ""
    ingest_recording_dir: str = ""
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
    # Wall-clock estimate of the encode pipeline's sample-loop start (t=0 of
    # upload-sample `elapsed_sec`), derived on the first sample's arrival as
    # (arrival wall time − sample.elapsed_sec). Upload samples count elapsed
    # from pipeline start, while the browser's playback samples were counted
    # from started_at_epoch/first_sample_at_epoch — a ~6s base mismatch on
    # webcam jobs that made every exact-elapsed merge miss (persisted
    # playback_*/e2e_latency_ms were all 0). Playback samples are rebased onto
    # this epoch via their `at_epoch` wall stamp.
    pipeline_start_epoch: Optional[float] = None
    # Wall-clock time of the first sample carrying real encode data (bitrate
    # or fps > 0), as opposed to `started_at_epoch` (job thread creation).
    # Protocol setup cost before frames flow — endpoint probes, Zixi SRT
    # ingest lock wait, HLS preview gating — varies a lot by protocol, so
    # anchoring glass-to-glass latency at thread-start biases slower-to-set-up
    # protocols (e.g. RTMP endpoint probing) toward reporting inflated e2e
    # latency versus protocols that start encoding sooner. This is the fairer
    # cross-protocol anchor; started_at_epoch remains as a fallback for
    # clients that haven't picked up the new field yet.
    first_sample_at_epoch: Optional[float] = None
    # Wall epoch stamped immediately before the leg ENCODER process spawns
    # (after endpoint probes / ingest locks, before ffmpeg pipeline delay).
    # This is the glass-to-glass latency anchor: with -re/live capture, media
    # time m is read at media_zero_epoch + m. first_sample_at_epoch lags this
    # by the encoder pipeline delay (~2s measured 2026-08-09: x264 lookahead +
    # mux buffering before ffmpeg's first progress report), which understated
    # every leg's e2e latency by the same amount.
    media_zero_epoch: Optional[float] = None
    # LL-HLS (MediaMTX) only: encoder→packager transit measured server-side as
    # first EXT-X-PROGRAM-DATE-TIME − (media_zero_epoch + segment media time).
    # The browser adds this to PDT-based player latency, which otherwise
    # misses SRT tsbpd + network + remux upstream of the packager.
    packager_transit_ms: Optional[float] = None
    # Zixi Fast HLS: encode-media seconds corresponding to hls.js buffer time 0.
    delivery_media_origin_sec: Optional[float] = None
    playback_samples: List[dict] = field(default_factory=list)
    playback_engine: str = ""
    publisher_host: str = "cloud"
    cancel_event: threading.Event = field(default_factory=threading.Event)


class JobManager:
    def __init__(self):
        self._jobs: Dict[str, UploadJobRecord] = {}
        self._lock = threading.Lock()
        self._service = UploadService()
        self._encode_slots = CloudEncodeSlotPool()
        self._path_probes: Dict[str, object] = {}
        self._moqx_pollers: Dict[str, object] = {}
        self._ingest_pollers: Dict[str, object] = {}
        self._moqx_recv_bytes: Dict[str, int] = {}

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
                from zixi_stats import zixi_api_base_for_endpoint

                zixi_playback_stream_id = (
                    ensure_error_concealed_stream(
                        zixi_stream_id,
                        base_url=zixi_api_base_for_endpoint(job.destination.url),
                    )
                    or zixi_stream_id
                )
        elif job.destination.protocol == "rtmp":
            from moq_publish import (
                zixi_rtmp_stream_id_for_preset,
                zixi_stream_id_from_rtmp_url,
            )

            # Gate RTMP→Zixi Fast HLS the same way as SRT: wait for a readable
            # segment before the browser attaches (avoids burning TTFF on the
            # preflight + empty-playlist poll). Stream id is the RTMP key
            # (preset default "benchmark").
            zixi_stream_id = zixi_rtmp_stream_id_for_preset(preset_id) or zixi_stream_id_from_rtmp_url(
                job.destination.url
            )
            zixi_playback_stream_id = zixi_stream_id

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
        # HTTP-TS PUT presets are encode-only on current Broadcaster settings —
        # do not gate them on missing playback. See needs_publish_preview for
        # why MoQ needs this gate too, not just Zixi/MediaMTX HLS.
        preview_ready = not needs_publish_preview(
            job.destination.protocol,
            zixi_stream_id=zixi_stream_id or "",
            ingest_provider=ingest_provider,
        )

        publisher_host = (getattr(job, "publisher_host", None) or "cloud").strip().lower()
        if publisher_host not in {"cloud", "local", "browser"}:
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
            playback_policy=getattr(job, "playback_policy", None) or "live-edge",
            test_scope=getattr(job, "test_scope", None) or "e2e",
            ingest_agent_url=job.ingest_agent_url,
            ingest_recording_dir=job.ingest_recording_dir,
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
        job.on_media_zero = lambda epoch, _job_id=job_id: self._update(
            _job_id, media_zero_epoch=float(epoch)
        )
        job.on_packager_transit = lambda ms, _job_id=job_id: self._update(
            _job_id, packager_transit_ms=float(ms)
        )
        job.on_delivery_media_origin = lambda sec, _job_id=job_id: self._update(
            _job_id, delivery_media_origin_sec=float(sec)
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
        shared_url = ""
        if job_can_join_shared_encode(job):
            try:
                shared_url = attach_shared_encode(job, job.cancel_event)
            except Exception as exc:
                self._update(
                    job_id,
                    status=JobStatus.FAILED,
                    error=str(exc) or "Shared comparison encode failed to start",
                )
                return
            job.media_path = shared_url
            job.refresh_ffmpeg_cmd()
        needs_slot = (
            job_needs_cloud_encode_slot(getattr(job, "publisher_host", "cloud") or "cloud")
            and not shared_url
        )
        if needs_slot:
            self._update(job_id, status=JobStatus.QUEUED)
            acquired = self._encode_slots.acquire(job_id, job.cancel_event)
            if not acquired:
                self._update(
                    job_id,
                    status=JobStatus.FAILED,
                    error="Cancelled while waiting for a cloud encode slot",
                )
                return
        started_at_epoch = time.time()
        self._update(job_id, status=JobStatus.RUNNING, started_at_epoch=started_at_epoch)
        start_epoch = started_at_epoch
        result = None

        try:
            if job.compute_vmaf_on_ingest:
                threading.Thread(
                    target=self._prepare_remote_vmaf,
                    args=(job_id, job),
                    daemon=True,
                    name=f"vmaf-prep-{job_id}",
                ).start()

            def on_sample(sample: UploadSample) -> None:
                payload = live_sample_payload(sample)
                with self._lock:
                    record = self._jobs.get(job_id)
                    if record:
                        if record.pipeline_start_epoch is None:
                            record.pipeline_start_epoch = time.time() - sample.elapsed_sec
                        if record.first_sample_at_epoch is None and (
                            sample.encoded_bitrate_kbps > 0 or sample.fps > 0
                        ):
                            record.first_sample_at_epoch = time.time()
                        self._apply_playback_fields(payload, record.playback_samples)
                        record.samples.append(payload)

            if job.publisher_host == "browser":
                result = self._run_browser_publisher_job(job_id, job)
            elif job.publisher_host == "local" and local_publisher_enabled() and publisher_hub is not None:
                result = publisher_hub.run_remote(
                    job,
                    on_sample=on_sample,
                    on_preview_ready=job.on_preview_ready,
                    on_encoder_vmaf_status=job.on_encoder_vmaf_status,
                    on_media_zero=job.on_media_zero,
                    on_packager_transit=job.on_packager_transit,
                    on_delivery_media_origin=job.on_delivery_media_origin,
                )
            else:
                if job.publisher_host == "local" and not local_publisher_enabled():
                    result = UploadResult(
                        success=False,
                        error=(
                            "publisher_host=local requires LOCAL_PUBLISHER_ENABLED=1 "
                            "(use ./scripts/dev.sh + ./scripts/run-local-publisher.sh)."
                        ),
                    )
                else:
                    result = self._service.run(job, on_sample=on_sample)
            end_epoch = time.time()
            if result is None:
                raise RuntimeError("Upload job produced no result")
            if result.success:
                self._persist_playback_metrics(job_id, result.summary_path)
                csv_path = result.csv_path
                if not csv_path or not os.path.isfile(csv_path):
                    # Local-agent CSVs live on the laptop; rewrite from samples
                    # so /api/results/{filename} can serve the Results tab.
                    csv_path = self._persist_collected_samples_csv(job_id, job) or csv_path
                self._update(
                    job_id,
                    status=JobStatus.COMPLETED,
                    csv_path=csv_path,
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
                csv_path = result.csv_path
                if not csv_path:
                    csv_path = self._persist_collected_samples_csv(job_id, job)
                self._update(
                    job_id,
                    status=JobStatus.FAILED,
                    error=classify_result_error(
                        result.error or "Upload failed",
                        media_path=str(getattr(job, "media_path", "") or ""),
                    ),
                    csv_path=csv_path,
                    summary_path=result.summary_path,
                    vmaf_status=VmafStatus.FAILED.value if job.compute_vmaf_on_ingest else VmafStatus.DISABLED.value,
                    vmaf_error=result.error if job.compute_vmaf_on_ingest else None,
                    encoder_vmaf_status=(
                        VmafStatus.FAILED.value if job.compute_vmaf_encoder else VmafStatus.DISABLED.value
                    ),
                    encoder_vmaf_error=result.error if job.compute_vmaf_encoder else None,
                )
        except Exception as exc:
            self._update(
                job_id,
                status=JobStatus.FAILED,
                error=classify_job_exception(
                    exc,
                    media_path=str(getattr(job, "media_path", "") or ""),
                )
                or "Upload failed",
            )
            raise
        finally:
            if shared_url:
                release_shared_encode(job)
            if needs_slot:
                self._encode_slots.release(job_id)
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
        browser_source = is_device_browser_source(job.media_path)
        if browser_source:
            # The in-tab encoder uploads Annex-B during the run — there is no
            # file at job.media_path. Still start the MoQ recorder now.
            self._update(job_id, vmaf_status=VmafStatus.WAITING_FOR_UPLOAD.value, vmaf_error=None)
        else:
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
            if _is_zixi_provider(job.destination.ingest_provider or ""):
                self._start_zixi_http_ts_capture(job_id, job)
            return

        # Same namespace-live gate as the player (should_mark_moq_preview_ready).
        # Starting the recorder immediately SUBSCRIBEs before PUBLISH_NAMESPACE
        # and inflates relay track_not_exist — the comparison then looks like
        # playback is broken when only ingest VMAF raced the publisher.
        deadline = time.time() + min(45.0, max(8.0, float(job.duration_sec or 8)))
        preview_ready = False
        while time.time() < deadline:
            with self._lock:
                live = self._jobs.get(job_id)
                if live is None:
                    return
                preview_ready = bool(live.preview_ready)
                cancelled = live.cancel_event.is_set()
                status = live.status
            if preview_ready or cancelled or status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                break
            time.sleep(0.4)
        if not preview_ready:
            self._update(
                job_id,
                vmaf_status=VmafStatus.FAILED.value,
                vmaf_error=(
                    "MoQ ingest VMAF waited for this job's namespace to go live "
                    "before subscribing; preview never became ready. Encode and "
                    "playback still run."
                ),
            )
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
            cert_sha256=fingerprint_for_relay_url(relay_url) or "",
            video_track="video" if browser_source else "vide_1",
        )
        if record_error:
            self._update(job_id, vmaf_status=VmafStatus.FAILED.value, vmaf_error=record_error)

    def _start_zixi_http_ts_capture(self, job_id: str, job: UploadJob) -> None:
        """Pull HTTP-TS while the Zixi push is live so ingest VMAF has media."""
        deadline = time.time() + min(20.0, max(6.0, float(job.duration_sec or 8)))
        preview_ready = False
        while time.time() < deadline:
            with self._lock:
                live = self._jobs.get(job_id)
                if live is None:
                    return
                preview_ready = bool(live.preview_ready)
                cancelled = live.cancel_event.is_set()
                status = live.status
            if preview_ready or cancelled or status in {JobStatus.COMPLETED, JobStatus.FAILED}:
                break
            time.sleep(0.4)
        if not preview_ready:
            self._update(
                job_id,
                vmaf_status=VmafStatus.FAILED.value,
                vmaf_error=(
                    "Zixi ingest VMAF waited for HTTP-TS to become readable "
                    "before capturing; preview never became ready. Encode and "
                    "playback still run."
                ),
            )
            return
        stream_id = (
            (job.zixi_playback_stream_id or "").strip()
            or (job.managed_zixi_stream_id() or "")
        ).strip()
        if not stream_id:
            self._update(
                job_id,
                vmaf_status=VmafStatus.FAILED.value,
                vmaf_error="Zixi ingest VMAF has no HTTP-TS stream id to capture",
            )
            return
        from zixi_hls_health import zixi_ingest_http_ts_url

        url = zixi_ingest_http_ts_url(
            stream_id,
            endpoint_url=job.destination.url,
            agent_url=job.ingest_agent_url,
        )
        record_error = start_http_ts_capture_via_agent(
            job.destination.url,
            job_id,
            http_ts_url=url,
            duration_sec=job.duration_sec,
            agent_url=job.ingest_agent_url,
            recording_dir=job.ingest_recording_dir,
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

        if _is_zixi_provider(job.destination.ingest_provider or ""):
            stop_http_ts_capture_via_agent(
                job.destination.url,
                job_id,
                agent_url=job.ingest_agent_url,
                recording_dir=job.ingest_recording_dir,
            )

        self._update(job_id, vmaf_status=VmafStatus.COMPUTING.value, vmaf_error=None)
        remote_result = None
        for attempt in range(10):
            remote_result = compute_vmaf_via_agent(
                job.destination.url,
                job_id,
                start_epoch,
                end_epoch,
                agent_url=job.ingest_agent_url,
                recording_dir=job.ingest_recording_dir,
            )
            waiting_on_reference = bool(
                remote_result.error
                and "not uploaded" in remote_result.error.lower()
            )
            if not waiting_on_reference:
                break
            time.sleep(2)
        if remote_result is None:
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
        try:
            at_epoch = float(sample.get("at_epoch", 0) or 0)
        except (TypeError, ValueError):
            at_epoch = 0.0

        engine = str(sample.get("engine", "") or "").strip().lower()
        if engine == "monitor":
            # Confidence-monitor ticks stay isolated — never overlay glass
            # onto an upload leg's ranking e2e.
            return True
        payload = {"elapsed_sec": elapsed_sec}
        for name in PLAYBACK_FIELD_NAMES:
            # A startup phase the browser could not source arrives as null and
            # must stay null; every other playback column is a counter or gauge
            # whose absence really is zero.
            absent = None if name in PLAYBACK_NULLABLE_KEYS else 0
            try:
                value = sample.get(name, absent)
            except (TypeError, ValueError):
                value = absent
            payload[name] = absent if value is None else value
        payload["playback_policy"] = (
            "complete" if str(sample.get("playback_policy") or "").strip() == "complete" else "live-edge"
        )

        with self._lock:
            record = self._jobs.get(job_id)
            if not record:
                return False
            if (getattr(record, "test_scope", None) or "e2e") == "upload":
                return True
            # Rebase browser-side elapsed onto the pipeline's elapsed base so
            # this merges with upload samples (see pipeline_start_epoch).
            if at_epoch > 0 and record.pipeline_start_epoch is not None:
                rebased = int(at_epoch - record.pipeline_start_epoch)
                if rebased >= 0:
                    payload["elapsed_sec"] = rebased
                    elapsed_sec = rebased
            record.playback_samples.append(payload)
            if engine:
                record.playback_engine = engine
            # Playback ticks rarely land on the exact same integer second as an
            # upload sample — attach to the latest sample at-or-before instead.
            target = None
            for live_sample in record.samples:
                live_elapsed = live_sample.get("elapsed_sec")
                if isinstance(live_elapsed, (int, float)) and live_elapsed <= elapsed_sec:
                    target = live_sample
            if target is None and record.samples:
                target = record.samples[-1]
            if target is not None:
                merged = _playback_high_water(target, payload)
                for name in PLAYBACK_FIELD_NAMES:
                    target[name] = merged[name]
                _recompute_derived(target, engine=engine, playback_live=True)
        return True

    def record_browser_encode_sample(self, job_id: str, sample: dict) -> bool:
        try:
            elapsed_sec = int(round(float(sample.get("elapsed_sec", -1))))
        except (TypeError, ValueError):
            return False
        if elapsed_sec < 0:
            return False

        def _num(key: str, *aliases: str) -> float:
            for name in (key, *aliases):
                if sample.get(name) not in (None, ""):
                    try:
                        return float(sample.get(name) or 0)
                    except (TypeError, ValueError):
                        return 0.0
            return 0.0

        send_mbps = _num("encoder_send_rate_mbps", "net_send_mbps")
        recv_mbps = _num("net_recv_mbps", "transport_recv_rate_mbps")
        rtt_ms = _num("net_rtt_ms", "transport_rtt_ms")
        jitter_ms = _num("net_jitter_ms", "transport_rtt_jitter_ms")
        payload = {
            "elapsed_sec": elapsed_sec,
            "encoded_bitrate_kbps": _num("encoded_bitrate_kbps"),
            "fps": _num("fps"),
            "fps_stability": 1.0,
            "speed": 1.0,
            "out_time": "",
            "cpu_percent": 0.0,
            "memory_mb": 0.0,
            "progress": str(sample.get("progress") or "continue"),
            "encoder_send_rate_mbps": send_mbps,
            "encode_lag_ms": _num("encode_lag_ms"),
            "transport_rtt_ms": rtt_ms or _num("transport_rtt_ms"),
            "transport_rtt_jitter_ms": jitter_ms,
            "net_rtt_ms": rtt_ms or _num("transport_rtt_ms"),
            "net_jitter_ms": jitter_ms,
            "net_send_mbps": send_mbps or _num("net_send_mbps"),
            "net_recv_mbps": recv_mbps,
            "transport_recv_rate_mbps": recv_mbps,
            "net_loss_pct": _num("net_loss_pct"),
            "net_retrans_pct": _num("net_retrans_pct"),
            "pkt_snd_loss": _num("pkt_snd_loss"),
            "pkt_retrans": _num("pkt_retrans"),
        }
        if sample.get("vmaf_score") not in (None, ""):
            payload["vmaf_score"] = _num("vmaf_score")
        with self._lock:
            record = self._jobs.get(job_id)
            if not record or record.publisher_host != "browser":
                return False
            protocol = record.protocol
            endpoint_url = record.endpoint_url
            preset_id = record.preset_id
            ingest_agent_url = record.ingest_agent_url
        if float(payload["net_rtt_ms"] or 0) <= 0 and (protocol or "").lower() == "moq":
            rtt_ms, jitter_ms = self._browser_moq_path_rtt(job_id, endpoint_url)
            if rtt_ms > 0:
                payload["transport_rtt_ms"] = rtt_ms
                payload["net_rtt_ms"] = rtt_ms
                if float(payload["net_jitter_ms"] or 0) <= 0:
                    payload["net_jitter_ms"] = jitter_ms
                    payload["transport_rtt_jitter_ms"] = jitter_ms
        payload.update(
            self._browser_transport_enrichment(
                job_id,
                protocol=protocol,
                endpoint_url=endpoint_url,
                preset_id=preset_id,
                ingest_agent_url=ingest_agent_url,
            )
        )
        with self._lock:
            record = self._jobs.get(job_id)
            if not record or record.publisher_host != "browser":
                return False
            if record.pipeline_start_epoch is None:
                record.pipeline_start_epoch = time.time() - elapsed_sec
            if record.media_zero_epoch is None:
                record.media_zero_epoch = record.pipeline_start_epoch
            if record.first_sample_at_epoch is None and (
                payload["encoded_bitrate_kbps"] > 0 or payload["fps"] > 0
            ):
                record.first_sample_at_epoch = time.time()
            self._apply_playback_fields(payload, record.playback_samples)
            record.samples.append(payload)
        return True

    def _browser_moq_path_rtt(self, job_id: str, endpoint_url: str) -> tuple:
        """TCP connect RTT to the relay admin port (same probe ffmpeg MoQ uses)."""
        with self._lock:
            probe = self._path_probes.get(job_id)
            if probe is None:
                try:
                    from path_rtt import PathRttProbe

                    probe = PathRttProbe(endpoint_url)
                    self._path_probes[job_id] = probe
                except Exception:
                    return (0.0, 0.0)
        try:
            snap = probe.poll()  # type: ignore[union-attr]
        except Exception:
            return (0.0, 0.0)
        return (
            float(getattr(snap, "rtt_ms", 0) or 0),
            float(getattr(snap, "jitter_ms", 0) or 0),
        )

    def _browser_transport_enrichment(
        self,
        job_id: str,
        *,
        protocol: str,
        endpoint_url: str,
        preset_id: str,
        ingest_agent_url: str,
    ) -> dict:
        """Fill the same net/moqx/host columns ffmpeg legs write.

        Browser publishers only POST encode telemetry. Without this merge the
        comparison CSV drops moqx_*, quic_*, net_recv, loss, and cloud fields
        even though the relay and ingest agent already expose them.
        """
        extra: dict = {}
        try:
            from destinations import PRESET_BY_ID
            from cloud_placement import placement_from_ingest_provider

            preset = PRESET_BY_ID.get(preset_id) if preset_id else None
            ingest_provider = (
                (preset.ingest_provider if preset else "")
                or ""
            )
            placement = placement_from_ingest_provider(ingest_provider)
            extra["cloud_provider"] = (
                (preset.cloud_provider if preset else "") or placement.cloud_provider
            )
            extra["cloud_region"] = (
                (preset.cloud_region if preset else "") or placement.cloud_region
            )
        except Exception:
            ingest_provider = ""

        if (protocol or "").lower() == "moq":
            extra.update(self._browser_moqx_fields(job_id, endpoint_url))

        try:
            from ingest_host_metrics import IngestHostMetricsPoller, measured_server_cpu

            with self._lock:
                poller = self._ingest_pollers.get(job_id)
                if poller is None:
                    poller = IngestHostMetricsPoller(
                        endpoint_url,
                        agent_url=ingest_agent_url,
                        ingest_provider=ingest_provider,
                        publisher_host="browser",
                    )
                    self._ingest_pollers[job_id] = poller
            if getattr(poller, "enabled", False):
                host = poller.poll()
                cpu = measured_server_cpu(host)
                if cpu is not None:
                    extra["server_cpu_percent"] = cpu
                    extra["server_memory_percent"] = float(host.memory_percent or 0)
                    extra["server_disk_percent"] = float(host.disk_percent or 0)
        except Exception:
            pass
        return extra

    def _browser_moqx_fields(self, job_id: str, endpoint_url: str) -> dict:
        try:
            from moqx_stats import MoqxStatsPoller
        except Exception:
            return {}
        with self._lock:
            poller = self._moqx_pollers.get(job_id)
            if poller is None:
                poller = MoqxStatsPoller(endpoint_url)
                self._moqx_pollers[job_id] = poller
        if not getattr(poller, "enabled", False):
            return {}
        try:
            poller.poll()
        except Exception:
            return {}
        deltas = poller.job_window_deltas()
        latest = poller._latest
        recv_mbps = 0.0
        with self._lock:
            prev_bytes = self._moqx_recv_bytes.get(job_id)
            self._moqx_recv_bytes[job_id] = latest.quic_bytes_read
        if prev_bytes is not None and latest.quic_bytes_read >= prev_bytes:
            recv_mbps = max(0.0, (latest.quic_bytes_read - prev_bytes) * 8 / 1_000_000)
        sent = max(deltas.quic_packets_sent, 1)
        loss_pct = 0.0
        retrans_pct = 0.0
        if deltas.quic_packets_sent > 0:
            loss_pct = min(100.0, (deltas.quic_packet_loss / sent) * 100.0)
            retrans_pct = min(
                100.0, (deltas.quic_packet_retransmissions / sent) * 100.0
            )
        return {
            "moqx_subscribe_success": deltas.subscribe_success,
            "moqx_subscribe_error": deltas.subscribe_error,
            "moqx_publish_namespace_success": deltas.publish_namespace_success,
            "moqx_publish_received": latest.publish_received,
            "moqx_publish_done": latest.publish_done,
            "quic_packets_lost": deltas.quic_packet_loss,
            "net_loss_pct": loss_pct,
            "net_retrans_pct": retrans_pct,
            "pkt_snd_loss": deltas.quic_packet_loss,
            "pkt_retrans": deltas.quic_packet_retransmissions,
            "net_recv_mbps": recv_mbps,
            "transport_recv_rate_mbps": recv_mbps,
        }

    def mark_browser_publisher_ready(self, job_id: str) -> bool:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record or record.publisher_host != "browser":
                return False
        self._update(job_id, preview_ready=True)
        return True

    def fail_browser_publisher(self, job_id: str, error: str) -> bool:
        """Fail one in-page publish leg without stopping the rest of a comparison."""
        message = (error or "").strip()[:500]
        if not message:
            return False
        with self._lock:
            record = self._jobs.get(job_id)
            if not record or record.publisher_host != "browser":
                return False
            if record.status not in {JobStatus.PENDING, JobStatus.QUEUED, JobStatus.RUNNING}:
                return False
            record.browser_error = message
            record.error = message
            record.cancel_event.set()
        return True

    def attach_browser_vmaf_reference(self, job_id: str, file_bytes: bytes, filename: str) -> Optional[str]:
        """Forward the in-tab encoder bitstream to the ingest worker as VMAF reference."""
        with self._lock:
            record = self._jobs.get(job_id)
            if not record or record.publisher_host != "browser":
                return "Job is not a browser publisher"
            if not record.compute_vmaf_on_ingest:
                return "Ingest VMAF was not requested for this job"
            endpoint_url = record.endpoint_url
            agent_url = record.ingest_agent_url
            recording_dir = record.ingest_recording_dir
        upload_error = prepare_reference_bytes_via_agent(
            endpoint_url,
            job_id,
            file_bytes,
            filename or "reference.h264",
            agent_url=agent_url,
            recording_dir=recording_dir,
        )
        return upload_error

    def _run_browser_publisher_job(self, job_id: str, job: UploadJob):
        """Wait for the in-page WASM publisher; do not spawn ffmpeg."""
        from upload_service import UploadResult

        deadline = time.time() + max(5, int(job.duration_sec or 300))
        record = None
        with self._lock:
            record = self._jobs.get(job_id)
        cancel = record.cancel_event if record else threading.Event()
        while time.time() < deadline and not cancel.is_set():
            cancel.wait(0.5)

        results_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "results")
        os.makedirs(results_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        suffix = job_id.replace("-", "")[:8]
        summary_path = os.path.join(results_dir, f"upload_{stamp}_{suffix}.summary.json")
        csv_path = os.path.join(results_dir, f"upload_{stamp}_{suffix}.csv")
        samples: List[dict] = []
        with self._lock:
            live = self._jobs.get(job_id)
            if live:
                samples = list(live.samples)
                browser_error = (live.browser_error or "").strip()
            else:
                samples = []
                browser_error = ""
        self._write_browser_metrics_csv(csv_path, job, samples)
        if browser_error:
            return UploadResult(success=False, error=browser_error, csv_path=csv_path)
        quality = {}
        if job.compute_vmaf_on_ingest:
            quality["ingest"] = {"status": "pending", "computed_on": "ingest_agent"}
        bitrate_vals = [float(s.get("encoded_bitrate_kbps") or 0) for s in samples]
        fps_vals = [float(s.get("fps") or 0) for s in samples]
        averages = {}
        if bitrate_vals:
            averages["encoded_bitrate_kbps"] = round(sum(bitrate_vals) / len(bitrate_vals), 1)
        if fps_vals:
            averages["fps"] = round(sum(fps_vals) / len(fps_vals), 2)
        payload = {
            "protocol": job.destination.protocol,
            "endpoint": job.destination.url,
            "samples": len(samples),
            "averages": averages,
            "extra": {
                **encode_profile_summary(job.encode_ladder, job.target_latency_ms),
                "comparison_id": getattr(job, "comparison_id", "") or "",
                "stream_index": int(getattr(job, "stream_index", 0) or 0),
                "stream_label": getattr(job, "stream_label", "") or "",
                "playback_policy": getattr(job, "playback_policy", None) or "live-edge",
                "test_scope": getattr(job, "test_scope", None) or "e2e",
            },
            "quality": quality,
        }
        with open(summary_path, mode="w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        return UploadResult(
            success=True,
            csv_path=csv_path,
            summary_path=summary_path,
            encoder_vmaf_status="disabled",
            encoder_vmaf_score=None,
            vmaf_score=None,
        )

    def _persist_collected_samples_csv(self, job_id: str, job: "UploadJob") -> Optional[str]:
        """Write SSE-collected samples to the API results/ dir.

        Local publisher agents write CSV on the laptop; the Results tab reads
        this host. Failed jobs previously left csv_path unset, so the tab
        stayed empty after a 251/capture death.
        """
        with self._lock:
            record = self._jobs.get(job_id)
            samples = list(record.samples) if record else []
        if not samples:
            return None
        results_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "results")
        os.makedirs(results_dir, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        suffix = job_id.replace("-", "")[:8]
        csv_path = os.path.join(results_dir, f"upload_{stamp}_{suffix}.csv")
        self._write_browser_metrics_csv(csv_path, job, samples)
        return csv_path

    @staticmethod
    def _write_browser_metrics_csv(csv_path: str, job: UploadJob, samples: List[dict]) -> None:
        from metrics import CSV_COLUMNS

        protocol = job.destination.protocol
        endpoint = job.destination.url
        cloud_provider = getattr(job.destination, "cloud_provider", "") or ""
        cloud_region = getattr(job.destination, "cloud_region", "") or ""
        with open(csv_path, mode="w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, extrasaction="ignore")
            writer.writeheader()
            for sample in samples:
                row = {col: sample.get(col, "") for col in CSV_COLUMNS}
                row["timestamp"] = str(sample.get("elapsed_sec", ""))
                row["protocol"] = protocol
                row["endpoint"] = endpoint
                if not row.get("cloud_provider"):
                    row["cloud_provider"] = cloud_provider
                if not row.get("cloud_region"):
                    row["cloud_region"] = cloud_region
                if not row.get("net_send_mbps") and sample.get("encoder_send_rate_mbps"):
                    row["net_send_mbps"] = sample["encoder_send_rate_mbps"]
                if not row.get("encoder_send_rate_mbps") and sample.get("net_send_mbps"):
                    row["encoder_send_rate_mbps"] = sample["net_send_mbps"]
                if not row.get("transport_recv_rate_mbps") and sample.get("net_recv_mbps"):
                    row["transport_recv_rate_mbps"] = sample["net_recv_mbps"]
                if not row.get("net_recv_mbps") and sample.get("transport_recv_rate_mbps"):
                    row["net_recv_mbps"] = sample["transport_recv_rate_mbps"]
                if not row.get("net_rtt_ms") and sample.get("transport_rtt_ms"):
                    row["net_rtt_ms"] = sample["transport_rtt_ms"]
                if not row.get("transport_rtt_ms") and sample.get("net_rtt_ms"):
                    row["transport_rtt_ms"] = sample["net_rtt_ms"]
                if not row.get("transport_rtt_jitter_ms") and sample.get("net_jitter_ms"):
                    row["transport_rtt_jitter_ms"] = sample["net_jitter_ms"]
                if not row.get("net_jitter_ms") and sample.get("transport_rtt_jitter_ms"):
                    row["net_jitter_ms"] = sample["transport_rtt_jitter_ms"]
                writer.writerow(row)

    @staticmethod
    def _apply_playback_fields(payload: dict, playback_samples: List[dict]) -> None:
        if not playback_samples:
            return
        elapsed = payload.get("elapsed_sec")
        # Nearest at-or-before (both series now share the pipeline elapsed
        # base); exact-equality matching missed nearly every second.
        matched = None
        if isinstance(elapsed, (int, float)):
            for sample in reversed(playback_samples):
                sample_elapsed = sample.get("elapsed_sec")
                if isinstance(sample_elapsed, (int, float)) and sample_elapsed <= elapsed:
                    matched = sample
                    break
        if matched is None:
            matched = playback_samples[-1]
        for name in PLAYBACK_FIELD_NAMES:
            payload[name] = matched.get(name, None if name in PLAYBACK_NULLABLE_KEYS else 0)
        _recompute_derived(payload, playback_live=True)

    def _persist_playback_metrics(self, job_id: str, summary_path: Optional[str]) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if not record or not record.playback_samples or not summary_path:
                return
            if (getattr(record, "test_scope", None) or "e2e") == "upload":
                return
            if (record.playback_engine or "").strip().lower() == "monitor":
                return
            playback_samples = list(record.playback_samples)
            playback_engine = record.playback_engine

        patch_summary_with_playback(
            summary_path,
            playback_samples,
            playback_engine=playback_engine,
        )

    def encode_slot_fields(self, job) -> dict:
        """Live encode-slot queue fields for API/SSE (not stored on the record)."""
        status = job.status.value if hasattr(job.status, "value") else str(job.status)
        return encode_slot_fields(
            self._encode_slots,
            job_id=getattr(job, "id", "") or "",
            publisher_host=getattr(job, "publisher_host", "cloud") or "cloud",
            status=status,
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
                playback_policy=getattr(record, "playback_policy", None) or "live-edge",
                test_scope=getattr(record, "test_scope", None) or "e2e",
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
                first_sample_at_epoch=record.first_sample_at_epoch,
                media_zero_epoch=record.media_zero_epoch,
                packager_transit_ms=record.packager_transit_ms,
                # Must copy — SSE/GET go through get_job(); dropping this left
                # RTMP Fast HLS e2e ~3.5s high (truth runs 2026-08-10).
                delivery_media_origin_sec=record.delivery_media_origin_sec,
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
                    playback_policy=getattr(record, "playback_policy", None) or "live-edge",
                    test_scope=getattr(record, "test_scope", None) or "e2e",
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
                    started_at_epoch=record.started_at_epoch,
                    first_sample_at_epoch=record.first_sample_at_epoch,
                    media_zero_epoch=record.media_zero_epoch,
                    packager_transit_ms=record.packager_transit_ms,
                    delivery_media_origin_sec=record.delivery_media_origin_sec,
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


def _read_summary_sidecar(csv_path: str) -> dict:
    base, _ = os.path.splitext(csv_path)
    summary_path = f"{base}.summary.json"
    if not os.path.exists(summary_path):
        return {}
    try:
        with open(summary_path, mode="r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def read_result_summary(csv_path: str) -> dict:
    rows = []
    with open(csv_path, mode="r") as file:
        reader = csv.DictReader(file)
        for row in reader:
            rows.append(row)

    sidecar = _read_summary_sidecar(csv_path)
    if not rows:
        # Header-only / failed-leg CSVs still have a sidecar with protocol.
        # Returning a stub without protocol made the Results tab throw on
        # result.protocol.toUpperCase() and unmount the SPA.
        return {
            "samples": 0,
            "protocol": sidecar.get("protocol") or "",
            "endpoint": sidecar.get("endpoint") or sidecar.get("endpoint_url") or "",
            "averages": sidecar.get("averages") or {},
            "throughput": sidecar.get("throughput") or {},
            "rows": [],
            "summary_extra": sidecar.get("extra") or {},
            "quality": sidecar.get("quality") or {},
        }

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
        "net_rtt_ms",
        "net_jitter_ms",
        "net_send_mbps",
        "net_recv_mbps",
        "net_loss_pct",
        "net_retrans_pct",
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

    # Headline fps from the frame counter over wall time. ffmpeg's per-sample
    # `fps=` is a true instantaneous rate, but the sample interval is not
    # constant, so an unweighted mean over-weights the short fast ticks — it
    # read 32.2-32.7 fps for a 30fps source on MoQ legs where the counter says
    # 29.78. See MetricsCollector._compute_averages for the same correction on
    # the write path; this is the read path that rebuilds from CSV.
    frame_counts = [
        _row_value(r, "encode_frames_total")
        for r in rows
        if str(r.get("encode_frames_total", "")).strip() not in ("", "0")
    ]
    stamps = [
        _row_value(r, "timestamp")
        for r in rows
        if str(r.get("timestamp", "")).strip() != ""
    ]
    if len(frame_counts) > 1 and len(stamps) > 1:
        wall_sec = max(stamps) - min(stamps)
        produced = max(frame_counts) - min(frame_counts)
        if wall_sec > 0 and produced > 0:
            averages["fps"] = round(produced / wall_sec, 3)

    # Live playback gauges are blanked once the player stops reporting (see
    # playback_metrics.PLAYBACK_STALE_AFTER_SEC). Averaging a blank as 0 would
    # replace "we stopped measuring" with "it dropped to zero", which is the
    # same forward-fill dishonesty in the other direction.
    for gauge in ("playback_buffer_sec", "playback_bitrate_bps", "playback_video_time_sec"):
        live = [
            _row_value(r, gauge)
            for r in rows
            if str(r.get(gauge, "")).strip() != ""
        ]
        averages[gauge] = round(sum(live) / len(live), 3) if live else 0.0

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
    e2e_stats = robust_e2e_stats(e2e_values)
    if e2e_stats:
        averages["e2e_latency_ms"] = round(e2e_stats["avg"], 1)
        averages["e2e_latency_max_ms"] = round(e2e_stats["max"], 1)

    vmaf_values = [float(r["vmaf_score"]) for r in rows if r.get("vmaf_score")]
    if vmaf_values:
        averages["vmaf_score"] = round(vmaf_values[-1], 3)

    summary_extra = sidecar.get("extra") or {}
    throughput = sidecar.get("throughput") or {}
    quality = sidecar.get("quality") or {}
    if sidecar:
        summary_payload = sidecar
        summary_averages = summary_payload.get("averages", {})
        for key in (
            "vmaf_score",
            "psnr_db",
            "ssim",
            "encode_lag_ms",
            "e2e_latency_ms",
            "fps_stability",
            "net_rtt_ms",
            "net_send_mbps",
            "net_recv_mbps",
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
        "protocol": rows[0].get("protocol") or sidecar.get("protocol") or "",
        "endpoint": rows[0].get("endpoint")
        or sidecar.get("endpoint")
        or sidecar.get("endpoint_url")
        or "",
        "averages": averages,
        "throughput": throughput,
        "rows": rows,
        "summary_extra": summary_extra,
        "quality": quality,
    }
