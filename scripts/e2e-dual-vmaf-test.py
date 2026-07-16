#!/usr/bin/env python3
"""Realistic dual-VMAF end-to-end smoke test via the running API."""

from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
API = "http://127.0.0.1:8000/api"
MEDIA = str(ROOT / "dummy.mp4")
DURATION_SEC = 20
POLL_INTERVAL_SEC = 2
MAX_WAIT_SEC = 600


def api_json(method: str, path: str, payload: dict | None = None) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed ({exc.code}): {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Cannot reach API at {API}: {exc}") from exc


def wait_for_job(job_id: str) -> dict:
    deadline = time.time() + MAX_WAIT_SEC
    last = {}
    while time.time() < deadline:
        job = api_json("GET", f"/uploads/{job_id}")
        last = job
        status = job.get("status")
        ingest_requested = bool(job.get("compute_vmaf_on_ingest"))
        ingest_done = job.get("vmaf_status") in {"completed", "failed", "disabled"}
        encoder_requested = bool(job.get("compute_vmaf_encoder"))
        encoder_done = job.get("encoder_vmaf_status") in {"completed", "failed", "disabled"}

        print(
            f"  {job_id[:8]} status={status} "
            f"encoder={job.get('encoder_vmaf_status')}({job.get('encoder_vmaf_score')}) "
            f"ingest={job.get('vmaf_status')}({job.get('vmaf_score')})",
            flush=True,
        )

        if status == "failed":
            raise RuntimeError(job.get("error") or "upload failed")
        if status != "completed":
            time.sleep(POLL_INTERVAL_SEC)
            continue
        if ingest_requested and not ingest_done:
            time.sleep(POLL_INTERVAL_SEC)
            continue
        if encoder_requested and not encoder_done:
            time.sleep(POLL_INTERVAL_SEC)
            continue
        return job
    raise TimeoutError(f"Timed out waiting for job {job_id}: {json.dumps(last, indent=2)}")


def load_summary(summary_path: str) -> dict:
    path = Path(summary_path)
    if not path.is_absolute():
        path = ROOT / summary_path
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def assert_quality_leg(leg: dict, *, label: str, expect_score: bool) -> None:
    status = leg.get("status")
    if status not in {"completed", "failed", "pending"}:
        raise AssertionError(f"{label}: unexpected status {status!r}")
    if expect_score:
        if status != "completed":
            raise AssertionError(
                f"{label}: expected completed with score, got status={status} error={leg.get('error')}"
            )
        if leg.get("vmaf_score") is None:
            raise AssertionError(f"{label}: missing vmaf_score in {leg}")
        print(
            f"    {label}: VMAF={leg.get('vmaf_score')} "
            f"PSNR={leg.get('psnr_db')} SSIM={leg.get('ssim')}",
            flush=True,
        )


def main() -> int:
    print("=== Dual VMAF end-to-end test ===", flush=True)
    health = api_json("GET", "/health")
    if health.get("status") != "ok":
        raise RuntimeError(f"API unhealthy: {health}")

    quality = api_json("GET", "/quality/available?preset_id=moq_zixi_gcp")
    if not quality["encoder"]["available"]:
        raise RuntimeError(f"Encoder VMAF unavailable: {quality['encoder']['reason']}")
    if not quality["ingest"]["available"]:
        raise RuntimeError(f"Ingest VMAF unavailable: {quality['ingest']['reason']}")

    moq_quality = api_json("GET", "/quality/available?preset_id=moq_gcp_relay")
    moq_ingest_configured = moq_quality["ingest"]["available"]
    if not moq_ingest_configured:
        print(
            "  MoQ relay ingest VMAF not configured "
            f"({moq_quality['ingest']['reason']}); encoder-only leg for MoQ",
            flush=True,
        )

    comparison_id = f"e2e-{uuid.uuid4().hex[:8]}"
    legs = [
        {
            "label": "MoQ relay",
            "preset_id": "moq_gcp_relay",
            "stream_index": 0,
            "compute_vmaf_encoder": True,
            "compute_vmaf_on_ingest": moq_ingest_configured,
        },
        {
            "label": "GCP Zixi SRT",
            "preset_id": "moq_zixi_gcp",
            "stream_index": 1,
            "compute_vmaf_encoder": True,
            "compute_vmaf_on_ingest": True,
        },
    ]

    print(f"Starting {len(legs)}-leg comparison ({DURATION_SEC}s each)...", flush=True)
    jobs = []
    for leg in legs:
        payload = {
            "media_path": MEDIA,
            "duration_sec": DURATION_SEC,
            "preset_id": leg["preset_id"],
            "comparison_id": comparison_id,
            "stream_index": leg["stream_index"],
            "stream_label": leg["label"],
            "compute_vmaf_encoder": leg["compute_vmaf_encoder"],
            "compute_vmaf_on_ingest": leg["compute_vmaf_on_ingest"],
        }
        job = api_json("POST", "/uploads", payload)
        jobs.append((leg, job))
        print(f"  created {leg['label']}: {job['id']}", flush=True)

    print("Waiting for uploads + VMAF...", flush=True)
    finished = []
    for leg, job in jobs:
        print(f"Polling {leg['label']}...", flush=True)
        finished.append((leg, wait_for_job(job["id"])))

    print("Validating summary JSON...", flush=True)
    for leg, job in finished:
        summary_path = job.get("summary_path")
        if not summary_path:
            raise AssertionError(f"{leg['label']}: missing summary_path")
        summary = load_summary(summary_path)
        quality_block = summary.get("quality", {})
        print(f"  {leg['label']} -> {summary_path}", flush=True)

        if leg["compute_vmaf_encoder"]:
            encoder = quality_block.get("encoder")
            if not encoder:
                raise AssertionError(f"{leg['label']}: missing quality.encoder")
            assert_quality_leg(encoder, label=f"{leg['label']} encoder", expect_score=True)
            if job.get("encoder_vmaf_score") != encoder.get("vmaf_score"):
                raise AssertionError(
                    f"{leg['label']}: job encoder score {job.get('encoder_vmaf_score')} "
                    f"!= summary {encoder.get('vmaf_score')}"
                )

        if leg["compute_vmaf_on_ingest"]:
            ingest = quality_block.get("ingest")
            if not ingest:
                raise AssertionError(f"{leg['label']}: missing quality.ingest")
            if ingest.get("status") == "completed":
                assert_quality_leg(ingest, label=f"{leg['label']} ingest", expect_score=True)
                if job.get("vmaf_score") != ingest.get("vmaf_score"):
                    raise AssertionError(
                        f"{leg['label']}: job ingest score {job.get('vmaf_score')} "
                        f"!= summary {ingest.get('vmaf_score')}"
                    )
                averages = summary.get("averages", {})
                if averages.get("vmaf_score") != ingest.get("vmaf_score"):
                    raise AssertionError(f"{leg['label']}: legacy averages.vmaf_score mismatch")
            elif ingest.get("status") == "failed":
                print(
                    f"    {leg['label']} ingest: FAILED ({ingest.get('error') or job.get('vmaf_error')})",
                    flush=True,
                )
            else:
                raise AssertionError(f"{leg['label']}: unexpected ingest status {ingest.get('status')}")

        if not leg["compute_vmaf_on_ingest"]:
            ingest = quality_block.get("ingest")
            if ingest:
                raise AssertionError(f"{leg['label']}: unexpected quality.ingest block")

    print("PASS: dual VMAF end-to-end test succeeded", flush=True)
    print(json.dumps({"comparison_id": comparison_id, "jobs": [j["id"] for _, j in finished]}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc
