#!/usr/bin/env python3
"""Time-to-first-frame for a leg published by the *laptop* helper.

The 23 s RTMP → Linode Zixi regression (docs/RTMP-STARTUP.md) was measured
with the local publisher agent, not cloud encode, so confirming the fix has to
use the same publisher. The matrix harness only starts cloud jobs; this starts
a ``publisher_host=local`` job, waits for ingest, then drives the real site
player and reports the TTFF the player recorded.

Usage:
    scripts/qa_local_ttff.py moq_zixi_linode_rtmp mpegts
    DURATION=40 scripts/qa_local_ttff.py moq_zixi_linode_rtmp mpegts
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_ingest_matrix_test import BASE_URL, api, run_site_player  # noqa: E402

DURATION = int(os.environ.get("DURATION", "40"))
PLAYER_SEC = float(os.environ.get("SITE_PLAYER_SEC", "25"))
MEDIA = os.environ.get("MEDIA", "dummy.mp4")


def start_local_job(preset_id: str) -> str:
    job = api(
        "POST",
        "/api/uploads",
        data={
            "media_path": MEDIA,
            "preset_id": preset_id,
            "duration_sec": DURATION,
            "compute_vmaf_on_ingest": False,
            "compute_vmaf_encoder": False,
            "publisher_host": "local",
            "encoder": "ffmpeg",
            "stream_label": "laptop TTFF",
        },
    )
    # POST /api/uploads returns the job record, whose identifier field is `id`.
    # This script read `job_id` and died with a KeyError *after* successfully
    # starting the job, which is why the laptop leg looked blocked on the API
    # rejecting the media file — the media had already been accepted and the
    # encoder was running.
    job_id = job.get("id") or job.get("job_id")
    if not job_id:
        raise RuntimeError(f"no job id in response: {json.dumps(job)[:800]}")
    return str(job_id)


def wait_for_ingest(job_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = api("GET", f"/api/uploads/{job_id}")
        if status.get("error"):
            raise RuntimeError(f"job error: {status['error']}")
        if status.get("preview_ready") or (status.get("samples") or []):
            return status
        if status.get("status") in {"completed", "failed"}:
            return status
        time.sleep(0.5)
    raise TimeoutError("ingest never became ready")


def main() -> int:
    preset_id = sys.argv[1] if len(sys.argv) > 1 else "moq_zixi_linode_rtmp"
    mode = sys.argv[2] if len(sys.argv) > 2 else "mpegts"
    print(f"BASE_URL={BASE_URL} preset={preset_id} player={mode} duration={DURATION}s")

    started = time.monotonic()
    job_id = start_local_job(preset_id)
    print(f"job {job_id}")
    status = wait_for_ingest(job_id)
    print(f"ingest ready after {time.monotonic() - started:.1f}s "
          f"preview_ready={status.get('preview_ready')}")

    ok, detail = run_site_player(job_id, mode, PLAYER_SEC)
    print(f"site player ok={ok} {detail}")

    time.sleep(3)
    final = api("GET", f"/api/uploads/{job_id}")
    samples = final.get("samples") or []
    ttff = [s.get("playback_ttff_ms") for s in samples if s.get("playback_ttff_ms")]
    e2e = [s.get("e2e_latency_ms") for s in samples if s.get("e2e_latency_ms")]
    print(json.dumps({
        "job_id": job_id,
        "preset_id": preset_id,
        "player": mode,
        "playback_ttff_ms": ttff[0] if ttff else None,
        "e2e_latency_ms_first": e2e[0] if e2e else None,
        "samples": len(samples),
        "status": final.get("status"),
        "error": final.get("error"),
    }, indent=2))
    return 0 if ttff else 1


if __name__ == "__main__":
    raise SystemExit(main())
