import csv
import json
import os
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Optional

from upload_service import UploadJob, UploadSample, UploadService


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
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
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    csv_path: Optional[str] = None
    error: Optional[str] = None
    samples: List[dict] = field(default_factory=list)


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
        record = UploadJobRecord(
            id=job_id,
            status=JobStatus.PENDING,
            protocol=job.destination.protocol,
            endpoint_url=job.destination.url,
            media_path=job.media_path,
            duration_sec=job.duration_sec,
            preset_id=preset_id,
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

    def _run_job(self, job_id: str, job: UploadJob) -> None:
        self._update(job_id, status=JobStatus.RUNNING)

        def on_sample(sample: UploadSample) -> None:
            payload = {
                "elapsed_sec": sample.elapsed_sec,
                "bitrate_kbps": sample.bitrate_kbps,
                "fps": sample.fps,
                "speed": sample.speed,
                "out_time": sample.out_time,
                "cpu_percent": sample.cpu_percent,
                "memory_mb": sample.memory_mb,
                "progress": sample.progress,
            }
            with self._lock:
                record = self._jobs.get(job_id)
                if record:
                    record.samples.append(payload)

        result = self._service.run(job, on_sample=on_sample)

        if result.success:
            self._update(
                job_id,
                status=JobStatus.COMPLETED,
                csv_path=result.csv_path,
            )
        else:
            self._update(
                job_id,
                status=JobStatus.FAILED,
                error=result.error or "Upload failed",
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
                created_at=record.created_at,
                csv_path=record.csv_path,
                error=record.error,
                samples=list(record.samples),
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
                    created_at=record.created_at,
                    csv_path=record.csv_path,
                    error=record.error,
                    samples=[],
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
        files.append({
            "filename": name,
            "path": path,
            "modified_at": datetime.fromtimestamp(
                os.path.getmtime(path), tz=timezone.utc
            ).isoformat(),
            "size_bytes": os.path.getsize(path),
        })
    files.sort(key=lambda item: item["modified_at"], reverse=True)
    return files


def read_result_summary(csv_path: str) -> dict:
    rows = []
    with open(csv_path, mode="r") as file:
        reader = csv.DictReader(file)
        for row in reader:
            rows.append(row)

    if not rows:
        return {"samples": 0, "averages": {}}

    count = len(rows)
    averages = {
        "cpu_percent": round(sum(float(r["cpu_percent"]) for r in rows) / count, 2),
        "memory_mb": round(sum(float(r["memory_mb"]) for r in rows) / count, 2),
        "bitrate_kbps": round(sum(float(r["bitrate_kbps"]) for r in rows) / count, 2),
        "fps": round(sum(float(r.get("fps", 0) or 0) for r in rows) / count, 2),
        "speed": round(sum(float(r.get("speed", 0) or 0) for r in rows) / count, 2),
    }

    return {
        "samples": count,
        "protocol": rows[0].get("protocol", ""),
        "endpoint": rows[0].get("endpoint", ""),
        "averages": averages,
        "rows": rows,
    }
