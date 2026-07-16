#!/usr/bin/env python3
"""Overnight go-live verification: MOQ + SRT + RTMP upload, VMAF, playback probes."""

from __future__ import annotations

import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
API = "http://127.0.0.1:8000/api"
MEDIA = str(ROOT / "dummy.mp4")
DURATION_SEC = 20
POLL_INTERVAL_SEC = 2
MAX_WAIT_SEC = 600
REPORT_PATH = ROOT / "results" / f"go-live-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.json"

LEGS = [
    {
        "label": "MoQ relay",
        "preset_id": "moq_gcp_relay",
        "protocol": "moq",
        "playback": "moq",
        "compute_vmaf_encoder": True,
        "compute_vmaf_on_ingest": True,
    },
    {
        "label": "GCP Zixi SRT",
        "preset_id": "moq_zixi_gcp",
        "protocol": "srt",
        "playback": "hls",
        "hls_url": "http://35.222.33.58:7777/playback.m3u8?stream=SRT%20Test",
        "compute_vmaf_encoder": True,
        "compute_vmaf_on_ingest": True,
    },
    {
        "label": "GCP Zixi RTMP",
        "preset_id": "moq_zixi_gcp_rtmp",
        "protocol": "rtmp",
        "playback": "hls",
        "hls_url": "http://35.222.33.58:7777/playback.m3u8?stream=benchmark",
        "compute_vmaf_encoder": True,
        "compute_vmaf_on_ingest": True,
    },
]


def api_json(method: str, path: str, payload: dict | None = None, timeout: int = 30) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(f"{API}{path}", data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} failed ({exc.code}): {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"Cannot reach API at {API}: {exc}") from exc


def http_get_text(url: str, timeout: int = 10) -> tuple[int, str]:
    request = Request(url, headers={"Accept": "*/*"}, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")
    except URLError as exc:
        return 0, str(exc)


def wait_for_job(job_id: str) -> dict:
    deadline = time.time() + MAX_WAIT_SEC
    last = {}
    while time.time() < deadline:
        job = api_json("GET", f"/uploads/{job_id}")
        last = job
        status = job.get("status")
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
        ingest_requested = bool(job.get("compute_vmaf_on_ingest"))
        encoder_requested = bool(job.get("compute_vmaf_encoder"))
        ingest_done = job.get("vmaf_status") in {"completed", "failed", "disabled"}
        encoder_done = job.get("encoder_vmaf_status") in {"completed", "failed", "disabled"}
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


def probe_hls(url: str) -> dict:
    code, body = http_get_text(url)
    ok = code == 200 and ("#EXTM3U" in body)
    return {
        "url": url,
        "http_status": code,
        "ok": ok,
        "has_extm3u": "#EXTM3U" in body,
        "snippet": body[:120].replace("\n", " "),
    }


def probe_moq_relay() -> dict:
    code, body = http_get_text("http://34.28.164.90:8000/info")
    return {
        "url": "http://34.28.164.90:8000/info",
        "http_status": code,
        "ok": code == 200,
        "snippet": body[:160].replace("\n", " "),
    }


def run_leg(leg: dict, comparison_id: str, stream_index: int) -> dict:
    result: dict = {
        "label": leg["label"],
        "preset_id": leg["preset_id"],
        "protocol": leg["protocol"],
        "ok": False,
        "errors": [],
    }
    print(f"\n=== {leg['label']} ({leg['preset_id']}) ===", flush=True)

    quality = api_json("GET", f"/quality/available?preset_id={leg['preset_id']}")
    result["quality_available"] = quality
    if not quality.get("encoder", {}).get("available"):
        result["errors"].append(f"encoder VMAF unavailable: {quality.get('encoder', {}).get('reason')}")
    if leg["compute_vmaf_on_ingest"] and not quality.get("ingest", {}).get("available"):
        result["errors"].append(f"ingest VMAF unavailable: {quality.get('ingest', {}).get('reason')}")

    payload = {
        "media_path": MEDIA,
        "duration_sec": DURATION_SEC,
        "preset_id": leg["preset_id"],
        "comparison_id": comparison_id,
        "stream_index": stream_index,
        "stream_label": leg["label"],
        "compute_vmaf_encoder": leg["compute_vmaf_encoder"] and quality.get("encoder", {}).get("available", False),
        "compute_vmaf_on_ingest": leg["compute_vmaf_on_ingest"] and quality.get("ingest", {}).get("available", False),
    }
    job = api_json("POST", "/uploads", payload)
    result["job_id"] = job["id"]
    print(f"  created job {job['id']}", flush=True)

    # Mid-upload playback probe for HLS protocols
    if leg.get("playback") == "hls" and leg.get("hls_url"):
        time.sleep(8)
        result["playback_mid_upload"] = probe_hls(leg["hls_url"])
        print(f"  mid-upload HLS probe: {result['playback_mid_upload']}", flush=True)

    finished = wait_for_job(job["id"])
    result["job"] = {
        "status": finished.get("status"),
        "encoder_vmaf_status": finished.get("encoder_vmaf_status"),
        "encoder_vmaf_score": finished.get("encoder_vmaf_score"),
        "encoder_vmaf_error": finished.get("encoder_vmaf_error"),
        "vmaf_status": finished.get("vmaf_status"),
        "vmaf_score": finished.get("vmaf_score"),
        "vmaf_error": finished.get("vmaf_error"),
        "summary_path": finished.get("summary_path"),
        "error": finished.get("error"),
        "sample_count": len(finished.get("samples") or []),
    }

    if finished.get("summary_path"):
        summary = load_summary(finished["summary_path"])
        quality_block = summary.get("quality") or {}
        result["summary_quality"] = quality_block
        enc = quality_block.get("encoder") or {}
        ing = quality_block.get("ingest") or {}
        if payload["compute_vmaf_encoder"] and enc.get("status") != "completed":
            result["errors"].append(f"encoder VMAF not completed: {enc}")
        if payload["compute_vmaf_on_ingest"] and ing.get("status") != "completed":
            result["errors"].append(f"ingest VMAF not completed: {ing.get('error') or ing}")
        if result["job"]["sample_count"] < 5:
            result["errors"].append(f"too few metric samples: {result['job']['sample_count']}")

    if leg.get("playback") == "hls" and leg.get("hls_url"):
        # Post-upload probe (may still have last segments)
        result["playback_post_upload"] = probe_hls(leg["hls_url"])
        print(f"  post-upload HLS probe: {result['playback_post_upload']}", flush=True)
        if not (
            result.get("playback_mid_upload", {}).get("ok")
            or result.get("playback_post_upload", {}).get("ok")
        ):
            result["errors"].append("HLS playback URL never returned a valid playlist during/after upload")
    elif leg.get("playback") == "moq":
        result["playback_relay"] = probe_moq_relay()
        if not result["playback_relay"].get("ok"):
            result["errors"].append("MoQ relay admin /info unreachable")

    result["ok"] = not result["errors"] and finished.get("status") == "completed"
    print(f"  RESULT: {'PASS' if result['ok'] else 'FAIL'} {result['errors']}", flush=True)
    return result


def main() -> int:
    print("=== Go-live overnight suite ===", flush=True)
    health = api_json("GET", "/health")
    if health.get("status") != "ok":
        raise RuntimeError(f"API unhealthy: {health}")

    comparison_id = f"golive-{uuid.uuid4().hex[:8]}"
    print(f"comparison_id={comparison_id}", flush=True)

    # Sequential legs — avoids saturating ingest worker / Zixi
    results = []
    for index, leg in enumerate(LEGS):
        try:
            results.append(run_leg(leg, comparison_id, index))
        except Exception as exc:
            results.append(
                {
                    "label": leg["label"],
                    "preset_id": leg["preset_id"],
                    "protocol": leg["protocol"],
                    "ok": False,
                    "errors": [str(exc)],
                }
            )
            print(f"  RESULT: FAIL {exc}", flush=True)

    report = {
        "comparison_id": comparison_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "duration_sec": DURATION_SEC,
        "results": results,
        "all_ok": all(r.get("ok") for r in results),
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nReport: {REPORT_PATH}", flush=True)
    print(json.dumps({"all_ok": report["all_ok"], "legs": [
        {"label": r["label"], "ok": r["ok"], "errors": r.get("errors"), "ingest": (r.get("job") or {}).get("vmaf_score"), "encoder": (r.get("job") or {}).get("encoder_vmaf_score")}
        for r in results
    ]}, indent=2), flush=True)
    return 0 if report["all_ok"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1) from exc
