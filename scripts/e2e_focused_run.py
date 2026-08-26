#!/usr/bin/env python3
"""Focused prod E2E: file source, headed Chrome, ingest VMAF on capable legs."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("BASE_URL", "https://moq.sean-mccarthy.net")
os.environ["HEADED"] = "1"
os.environ["DURATION"] = os.environ.get("DURATION", "28")
os.environ["SITE_PLAYER_SEC"] = os.environ.get("SITE_PLAYER_SEC", "16")

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "e2e_ingest_matrix_test", ROOT / "scripts" / "e2e_ingest_matrix_test.py"
)
assert SPEC and SPEC.loader
e2e = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = e2e
SPEC.loader.exec_module(e2e)

CASES = [
    {
        "case": {
            "id": "zixi_rtmp_mpegts",
            "preset_id": "moq_zixi_gcp_rtmp",
            "playback": "mpegts",
            "url": "http://35.222.33.58:7777/benchmark.ts",
            "expect_preview": True,
            "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
        },
        "vmaf_ingest": True,
        "vmaf_encoder": True,
    },
    {
        "case": {
            "id": "zixi_rtmp_hls",
            "preset_id": "moq_zixi_gcp_rtmp",
            "playback": "hls",
            "url": "http://35.222.33.58:7777/playback.m3u8?stream=benchmark",
            "expect_preview": True,
            "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
            "fallback_playback": "mpegts",
        },
        "vmaf_ingest": False,
        "vmaf_encoder": False,
    },
    {
        "case": {
            "id": "moq_relay_playa",
            "preset_id": "moq_gcp_relay_d18",
            "playback": "moq",
            "url": "https://34-28-164-90.sslip.io:14433/moq-relay",
            "expect_preview": True,
            "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
            "requires_webtransport": True,
        },
        "vmaf_ingest": True,
        "vmaf_encoder": True,
    },
]


def selected_cases():
    wanted = {
        part.strip()
        for part in os.environ.get("CASE_IDS", "").split(",")
        if part.strip()
    }
    if not wanted:
        return CASES
    picked = [item for item in CASES if item["case"]["id"] in wanted]
    missing = wanted - {item["case"]["id"] for item in picked}
    if missing:
        raise SystemExit(f"unknown CASE_IDS: {sorted(missing)}")
    return picked


def start_job(preset_id: str, media_path: str, *, ingest: bool, encoder: bool) -> str:
    job = e2e.api(
        "POST",
        "/api/uploads",
        data={
            "media_path": media_path,
            "preset_id": preset_id,
            "duration_sec": e2e.DURATION,
            "compute_vmaf_on_ingest": ingest,
            "compute_vmaf_encoder": encoder,
        },
    )
    return job["id"]


def wait_vmaf(job_id: str, timeout: float = 240.0) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = e2e.get_job(job_id)
        status = last.get("status")
        ingest_req = bool(last.get("compute_vmaf_on_ingest"))
        enc_req = bool(last.get("compute_vmaf_encoder"))
        ingest_done = last.get("vmaf_status") in {"completed", "failed", "disabled"}
        enc_done = last.get("encoder_vmaf_status") in {"completed", "failed", "disabled"}
        if status == "failed":
            return last
        if status == "completed" and (not ingest_req or ingest_done) and (not enc_req or enc_done):
            return last
        time.sleep(3)
    return last


def idle_ok() -> None:
    data = e2e.api("GET", "/api/uploads")
    jobs = data.get("jobs") or []
    busy = [
        (j.get("id"), j.get("status"), j.get("preset_id"))
        for j in jobs
        if str(j.get("status") or "").lower() in {"running", "starting", "pending", "queued"}
    ]
    if busy:
        raise SystemExit(f"prod not idle: {busy}")
    print("idle ok", flush=True)


def main() -> int:
    cases = selected_cases()
    print(
        f"BASE_URL={e2e.BASE_URL} DURATION={e2e.DURATION} HEADED={e2e.HEADED} cases={[c['case']['id'] for c in cases]}",
        flush=True,
    )
    idle_ok()
    media_path = e2e.upload_media()
    print("uploaded", media_path, flush=True)
    out = []
    for item in cases:
        case = item["case"]
        print(
            f"\n== {case['id']} preset={case['preset_id']} vmaf_in={item['vmaf_ingest']} vmaf_enc={item['vmaf_encoder']} ==",
            flush=True,
        )
        e2e.start_job = lambda preset_id, media_path, _i=item: start_job(
            preset_id, media_path, ingest=_i["vmaf_ingest"], encoder=_i["vmaf_encoder"]
        )
        res = e2e.run_case(case, media_path)
        job = {}
        if res.job_id:
            job = wait_vmaf(res.job_id)
        payload = {
            "case_id": res.case_id,
            "ok": res.ok,
            "gated": res.gated,
            "gate_reason": res.gate_reason,
            "job_id": res.job_id,
            "ingest": res.ingest,
            "metrics": res.metrics,
            "chrome": res.chrome,
            "errors": res.errors,
            "detail": res.detail,
            "final_status": job.get("status"),
            "preset_id": case["preset_id"],
            "vmaf_status": job.get("vmaf_status"),
            "vmaf_score": job.get("vmaf_score"),
            "vmaf_error": job.get("vmaf_error"),
            "encoder_vmaf_status": job.get("encoder_vmaf_status"),
            "encoder_vmaf_score": job.get("encoder_vmaf_score"),
            "encoder_vmaf_error": job.get("encoder_vmaf_error"),
            "compute_vmaf_on_ingest": job.get("compute_vmaf_on_ingest"),
            "compute_vmaf_encoder": job.get("compute_vmaf_encoder"),
            "sample_count": len(job.get("samples") or []),
        }
        print(json.dumps({k: payload[k] for k in payload if k != "detail"}, default=str), flush=True)
        out.append(payload)
        time.sleep(3)
    dest = ROOT / "results" / "e2e_focused_latest.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("wrote", dest, flush=True)
    fails = sum(1 for p in out if not p["ok"] and not p.get("gated"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
