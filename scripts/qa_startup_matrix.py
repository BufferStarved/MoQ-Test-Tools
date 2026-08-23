#!/usr/bin/env python3
"""Live matrix for the startup phase breakdown: protocol x cloud provider.

Runs one leg per (protocol, provider), drives a real site player so the
player half of the chain is actually measured, then prints the phase
decomposition and both reconciliations straight from the result CSV.

The CSV is the source of truth rather than the live sample stream, because the
player-side phases only land after ``patch_summary_with_playback`` merges the
browser's samples back into the rows.

GCP west MediaMTX is deliberately absent from the WebRTC row: a concurrent
WHIP soak test holds that shared ``benchmark`` path, and the resulting session
eviction reads exactly like a network fault. WebRTC runs east and Linode only.

Usage:
    scripts/qa_startup_matrix.py                  # everything
    scripts/qa_startup_matrix.py rtmp moq         # only those protocols
    ONLY_PROVIDER=linode scripts/qa_startup_matrix.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from e2e_ingest_matrix_test import BASE_URL, api, run_site_player  # noqa: E402

from startup_budget import (  # noqa: E402
    PUBLISHER_STAGE_NAMES,
    PLAYER_STAGE_NAMES,
    STARTUP_PLAYER_COMPONENTS,
    STARTUP_PUBLISHER_COMPONENTS,
)

DURATION = int(os.environ.get("DURATION", "34"))
PLAYER_SEC = float(os.environ.get("SITE_PLAYER_SEC", "22"))
MEDIA = os.environ.get("MEDIA", "dummy.mp4")
OUT_DIR = Path(os.environ.get("OUT_DIR", ".qa-startup"))

# (protocol, provider, preset_id, player_mode)
LEGS = [
    ("srt", "gcp-west", "moq_zixi_gcp", "mpegts"),
    ("srt", "gcp-east", "moq_zixi_gcp_east", "mpegts"),
    ("srt", "linode", "moq_zixi_linode", "mpegts"),
    ("rtmp", "gcp-west", "moq_zixi_gcp_rtmp", "mpegts"),
    ("rtmp", "gcp-east", "moq_zixi_gcp_east_rtmp", "mpegts"),
    ("rtmp", "linode", "moq_zixi_linode_rtmp", "mpegts"),
    ("moq", "gcp-west", "moq_gcp_relay_d18", "moq"),
    ("moq", "gcp-east", "moq_gcp_east_relay_d18", "moq"),
    ("moq", "linode", "moq_linode_relay_d18", "moq"),
    # No gcp-west WebRTC: shared MediaMTX benchmark path is under soak test.
    ("webrtc", "gcp-east", "moq_mediamtx_gcp_east_whip", "whep"),
    ("webrtc", "linode", "moq_mediamtx_linode_whip", "whep"),
]


def start_job(preset_id: str, *, publisher_host: str = "cloud") -> str:
    job = api(
        "POST",
        "/api/uploads",
        data={
            "media_path": MEDIA,
            "preset_id": preset_id,
            "duration_sec": DURATION,
            "compute_vmaf_on_ingest": False,
            "compute_vmaf_encoder": False,
            "publisher_host": publisher_host,
            "encoder": "ffmpeg",
            "stream_label": "startup matrix",
        },
    )
    # The job record's identifier field is `id`; `job_id` does not exist on it.
    job_id = job.get("id") or job.get("job_id")
    if not job_id:
        raise RuntimeError(f"no job id in response: {json.dumps(job)[:600]}")
    return str(job_id)


def wait_for_ingest(job_id: str, timeout: float = 90.0) -> dict:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        last = api("GET", f"/api/uploads/{job_id}")
        if last.get("error"):
            return last
        if last.get("preview_ready") or (last.get("samples") or []):
            return last
        if last.get("status") in {"completed", "failed"}:
            return last
        time.sleep(0.5)
    return last


def wait_for_done(job_id: str, timeout: float = 180.0) -> dict:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        last = api("GET", f"/api/uploads/{job_id}")
        if last.get("status") in {"completed", "failed"}:
            return last
        time.sleep(2.0)
    return last


def _f(row: dict, key: str):
    raw = str(row.get(key, "") or "").strip()
    if raw == "":
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def fetch_result_row(job_id: str, status: dict) -> dict:
    """Last CSV row for the job: the merged, post-run truth."""
    csv_path = (status.get("csv_path") or "").strip()
    name = Path(csv_path).name if csv_path else ""
    if not name:
        listing = api("GET", "/api/results")
        files = listing if isinstance(listing, list) else listing.get("results", [])
        for item in files:
            fn = item if isinstance(item, str) else item.get("filename", "")
            if job_id[:8] in fn:
                name = fn
                break
    if not name:
        return {}
    import csv as _csv
    import io
    import urllib.request

    with urllib.request.urlopen(f"{BASE_URL}/api/results/{name}/download", timeout=60) as fh:
        text = fh.read().decode("utf-8", "replace")
    rows = list(_csv.DictReader(io.StringIO(text)))
    if not rows:
        return {}
    # Startup columns are one-shot facts repeated on every row; take the last
    # row so the post-run playback merge is included.
    return rows[-1]


def describe(protocol: str, provider: str, row: dict) -> dict:
    pub = {
        stage: _f(row, col)
        for stage, col in zip(PUBLISHER_STAGE_NAMES, STARTUP_PUBLISHER_COMPONENTS)
    }
    play = {
        stage: _f(row, col)
        for stage, col in zip(PLAYER_STAGE_NAMES, STARTUP_PLAYER_COMPONENTS)
    }
    return {
        "protocol": protocol,
        "provider": provider,
        "publisher_phases_ms": pub,
        "publisher_accounted_ms": _f(row, "startup_publisher_accounted_ms"),
        "publisher_measured_ms": _f(row, "startup_publisher_measured_ms"),
        "publisher_residual_ms": _f(row, "startup_publisher_residual_ms"),
        "publisher_overcount_ms": _f(row, "startup_publisher_overcount_ms"),
        "player_phases_ms": play,
        "player_accounted_ms": _f(row, "startup_player_accounted_ms"),
        "player_measured_ms": _f(row, "startup_player_measured_ms"),
        "player_residual_ms": _f(row, "startup_player_residual_ms"),
        "player_overcount_ms": _f(row, "startup_player_overcount_ms"),
        "playback_ttff_ms": _f(row, "playback_ttff_ms"),
        "unmeasured": str(row.get("startup_unmeasured", "") or ""),
        "not_applicable": str(row.get("startup_not_applicable", "") or ""),
        "playback_frames_rendered": _f(row, "playback_frames_rendered"),
    }


def render(entry: dict) -> str:
    lines = [f"--- {entry['protocol']} / {entry['provider']} ---"]
    lines.append("  publisher:")
    for stage, value in entry["publisher_phases_ms"].items():
        mark = "unmeasured" if value is None else f"{value:9.1f} ms"
        if value is None and stage in entry["not_applicable"].split(","):
            mark = "n/a"
        lines.append(f"    {stage:<20s} {mark}")
    lines.append(
        f"    {'= accounted':<20s} {entry['publisher_accounted_ms']} "
        f"vs measured {entry['publisher_measured_ms']} "
        f"(residual {entry['publisher_residual_ms']}, over {entry['publisher_overcount_ms']})"
    )
    lines.append("  player:")
    for stage, value in entry["player_phases_ms"].items():
        mark = "unmeasured" if value is None else f"{value:9.1f} ms"
        if value is None and stage in entry["not_applicable"].split(","):
            mark = "n/a"
        lines.append(f"    {stage:<20s} {mark}")
    lines.append(
        f"    {'= accounted':<20s} {entry['player_accounted_ms']} "
        f"vs TTFF {entry['player_measured_ms']} "
        f"(residual {entry['player_residual_ms']}, over {entry['player_overcount_ms']})"
    )
    lines.append(f"  unmeasured: {entry['unmeasured'] or '(none)'}")
    lines.append(f"  n/a:        {entry['not_applicable'] or '(none)'}")
    lines.append(f"  rendered:   {entry['playback_frames_rendered']}")
    return "\n".join(lines)


def main() -> int:
    wanted = {a.lower() for a in sys.argv[1:]} or None
    only_provider = os.environ.get("ONLY_PROVIDER", "").strip().lower()
    OUT_DIR.mkdir(exist_ok=True)
    print(f"BASE_URL={BASE_URL} duration={DURATION}s player={PLAYER_SEC}s")

    results = []
    for protocol, provider, preset_id, mode in LEGS:
        if wanted and protocol not in wanted:
            continue
        if only_provider and only_provider not in provider:
            continue
        print(f"\n=== {protocol} / {provider} ({preset_id}) ===", flush=True)
        try:
            job_id = start_job(preset_id)
        except Exception as exc:  # noqa: BLE001
            print(f"  start failed: {exc}")
            results.append({"protocol": protocol, "provider": provider, "error": str(exc)})
            continue
        print(f"  job {job_id}", flush=True)
        status = wait_for_ingest(job_id)
        if status.get("error"):
            print(f"  ingest error: {status['error']}")
        ok, detail = run_site_player(job_id, mode, PLAYER_SEC)
        print(f"  player[{mode}] ok={ok} {detail}", flush=True)
        final = wait_for_done(job_id)
        time.sleep(4)
        try:
            row = fetch_result_row(job_id, final)
        except Exception as exc:  # noqa: BLE001
            print(f"  csv fetch failed: {exc}")
            row = {}
        entry = describe(protocol, provider, row) if row else {
            "protocol": protocol, "provider": provider, "error": "no csv row",
        }
        entry["job_id"] = job_id
        entry["preset_id"] = preset_id
        entry["player_mode"] = mode
        entry["job_status"] = final.get("status")
        entry["job_error"] = final.get("error")
        results.append(entry)
        if "publisher_phases_ms" in entry:
            print(render(entry), flush=True)
        (OUT_DIR / "startup-matrix.json").write_text(json.dumps(results, indent=2))

    (OUT_DIR / "startup-matrix.json").write_text(json.dumps(results, indent=2))
    print(f"\nwrote {OUT_DIR / 'startup-matrix.json'} ({len(results)} legs)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
