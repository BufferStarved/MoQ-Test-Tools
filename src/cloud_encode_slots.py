"""Cap concurrent cloud ffmpeg encodes on the orchestrator VM.

A four-way BBB comparison used to spawn four libx264 jobs at once. The
encode host then ran at speed≈0.4x, dropped frames, and SIGTERM'd at
4–10s while RTMP/SRT sat on "Waiting" for HLS that never arrived.
Browser and laptop publishers do not take a slot — they do not use this
VM's CPU for encode.
"""

from __future__ import annotations

import os
import threading
from typing import Optional

DEFAULT_MAX_CONCURRENT_CLOUD_ENCODES = 1


def max_concurrent_cloud_encodes() -> int:
    raw = (os.environ.get("MAX_CONCURRENT_CLOUD_ENCODES") or "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return DEFAULT_MAX_CONCURRENT_CLOUD_ENCODES


def job_needs_cloud_encode_slot(publisher_host: str = "") -> bool:
    host = (publisher_host or "cloud").strip().lower()
    return host not in {"browser", "local"}


class CloudEncodeSlotPool:
    """Process-wide semaphore for cloud ffmpeg jobs."""

    def __init__(self, limit: Optional[int] = None) -> None:
        self.limit = limit if limit is not None else max_concurrent_cloud_encodes()
        self._sema = threading.BoundedSemaphore(self.limit)
        self._lock = threading.Lock()
        self._waiting: list[str] = []
        self._held: set[str] = set()

    def acquire(self, job_id: str, cancel_event: threading.Event, timeout: float = 1.0) -> bool:
        """Block until a slot is free or the job is cancelled.

        Returns True if this job holds a slot. Cancel while queued is not an
        encode crash — the caller should treat it as a clean stop.
        """
        token = (job_id or "").strip() or "unknown"
        with self._lock:
            if token not in self._waiting:
                self._waiting.append(token)
        try:
            while True:
                if cancel_event.is_set():
                    return False
                if self._sema.acquire(timeout=timeout):
                    with self._lock:
                        if token in self._waiting:
                            self._waiting.remove(token)
                        self._held.add(token)
                    return True
        finally:
            with self._lock:
                if token in self._waiting:
                    self._waiting.remove(token)

    def release(self, job_id: str) -> None:
        token = (job_id or "").strip() or "unknown"
        with self._lock:
            if token not in self._held:
                return
            self._held.discard(token)
        self._sema.release()

    def waiting_count(self) -> int:
        with self._lock:
            return len(self._waiting)

    def held_count(self) -> int:
        with self._lock:
            return len(self._held)

    def queue_ahead(self, job_id: str) -> int:
        """Jobs holding a slot or waiting in front of this one.

        0 means this job already holds a slot. A waiter behind one in-flight
        encode sees 1 — the UI can say "waiting for encode slot (1 ahead)"
        instead of pretending HLS/MoQ is already attaching.
        """
        token = (job_id or "").strip() or "unknown"
        with self._lock:
            if token in self._held:
                return 0
            held = len(self._held)
            try:
                return held + self._waiting.index(token)
            except ValueError:
                return held


def encode_slot_fields(
    pool: CloudEncodeSlotPool,
    *,
    job_id: str,
    publisher_host: str = "cloud",
    status: str = "",
) -> dict:
    """API/SSE fields for a job's cloud encode-slot state."""
    limit = pool.limit
    if not job_needs_cloud_encode_slot(publisher_host):
        return {
            "waiting_for_encode_slot": False,
            "encode_queue_ahead": 0,
            "encode_slot_limit": limit,
        }
    waiting = (status or "").strip().lower() == "queued"
    return {
        "waiting_for_encode_slot": waiting,
        "encode_queue_ahead": pool.queue_ahead(job_id) if waiting else 0,
        "encode_slot_limit": limit,
    }
