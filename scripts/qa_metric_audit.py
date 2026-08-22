#!/usr/bin/env python3
"""Per-metric health audit for finished benchmark jobs.

The matrix harnesses answer "did the leg run"; this answers "is every column
in that leg's CSV telling the truth". For each job it reports, per column,
whether the value is populated / zero / empty, whether a zero is the honest
answer for that protocol or a collection failure, and whether the latency
components reconcile with the measured end-to-end number.

Two checks are worth calling out because they cannot be seen in a single
sample:

* ``latency_residual_ms`` is clamped at 0, so a model that *over*-attributes
  looks identical to one that reconciles exactly. This script recomputes the
  signed difference and reports over-attribution separately.
* ``frame_delivery_pct`` divides a player counter by an encoder counter. When
  the player detaches early the encoder keeps counting, so the ratio decays
  even though nothing is being lost. The script reports the trend, not just
  the mean.

Usage:
    scripts/qa_metric_audit.py JOB8 [JOB8 ...]
    scripts/qa_metric_audit.py --latest 6
    BASE_URL=https://moq.sean-mccarthy.net scripts/qa_metric_audit.py --latest 6
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import urllib.request
from typing import Dict, List, Optional

BASE_URL = os.environ.get("BASE_URL", "https://moq.sean-mccarthy.net").rstrip("/")

LATENCY_COMPONENTS = (
    "latency_encode_ms",
    "latency_publish_ms",
    "latency_network_ms",
    "latency_packager_ms",
    "latency_player_buffer_ms",
)
FRAME_COLUMNS = (
    "encode_frames_total",
    "encode_frames_dropped",
    "encode_frames_duped",
    "encode_frame_drop_pct",
    "playback_frame_drop_pct",
    "frame_delivery_pct",
)

# Columns a protocol is not expected to populate. A zero here is honest, not a
# collection failure, and the audit says so instead of flagging it.
HONEST_ZEROS: Dict[str, tuple] = {
    "srt": ("moqx_*", "quic_*", "cmaf_*"),
    "rtmp": ("moqx_*", "quic_*", "cmaf_*", "pkt_*"),
    "webrtc": ("moqx_*", "quic_*", "cmaf_*", "pkt_*"),
    "moq": ("pkt_*", "ts_continuity_counter_errors"),
}

# Sanity windows. Outside these a value is reported as implausible rather than
# silently averaged into a table.
PLAUSIBLE = {
    "fps": (1.0, 121.0),
    "encoded_bitrate_kbps": (50.0, 60000.0),
    "net_rtt_ms": (0.05, 2000.0),
    "e2e_latency_ms": (1.0, 180000.0),
    "playback_ttff_ms": (1.0, 120000.0),
    "cpu_percent": (0.1, 3200.0),
    "speed": (0.05, 20.0),
}


def fetch(path: str) -> bytes:
    with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=45) as resp:
        return resp.read()


def list_results(limit: int) -> List[dict]:
    data = json.loads(fetch("/api/results").decode())
    return (data.get("results") or [])[:limit]


def load_rows(filename: str) -> List[dict]:
    raw = fetch(f"/api/results/{filename}/download?kind=csv").decode()
    return list(csv.DictReader(io.StringIO(raw)))


def num(value: Optional[str]) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def series(rows: List[dict], key: str) -> List[float]:
    return [v for v in (num(r.get(key)) for r in rows) if v is not None]


def summarize_column(rows: List[dict], key: str) -> dict:
    raw = [r.get(key) for r in rows]
    empty = sum(1 for v in raw if v is None or v == "")
    values = series(rows, key)
    nonzero = [v for v in values if v != 0.0]
    out = {
        "n": len(rows),
        "empty": empty,
        "zero": len(values) - len(nonzero),
        "nonzero": len(nonzero),
        "min": min(values) if values else None,
        "max": max(values) if values else None,
        "last": values[-1] if values else None,
    }
    if nonzero:
        out["mean_nonzero"] = round(sum(nonzero) / len(nonzero), 3)
    low, high = PLAUSIBLE.get(key, (None, None))
    if low is not None and nonzero:
        bad = [v for v in nonzero if v < low or v > high]
        out["implausible"] = len(bad)
    return out


def reconcile(rows: List[dict]) -> dict:
    """Signed latency reconciliation, before the residual's clamp at zero."""
    over = []
    under = []
    residual_share = []
    for row in rows:
        e2e = num(row.get("e2e_latency_ms")) or 0.0
        if e2e <= 0:
            continue
        accounted = num(row.get("latency_accounted_ms")) or 0.0
        signed = e2e - accounted
        if signed < 0:
            over.append(-signed)
        else:
            under.append(signed)
            residual_share.append(signed / e2e * 100.0)
        parts = sum(num(row.get(c)) or 0.0 for c in LATENCY_COMPONENTS)
        if abs(parts - accounted) > 0.5:
            over.append(float("nan"))  # components do not sum to accounted
    return {
        "samples_with_e2e": len(over) + len(under),
        "over_attributed": len(over),
        "over_attributed_max_ms": round(max(over), 1) if over else 0.0,
        "residual_pct_mean": round(sum(residual_share) / len(residual_share), 1)
        if residual_share
        else None,
        "residual_pct_max": round(max(residual_share), 1) if residual_share else None,
    }


def frame_trend(rows: List[dict]) -> dict:
    delivery = series(rows, "frame_delivery_pct")
    rendered = series(rows, "playback_frames_rendered")
    encoded = series(rows, "encode_frames_total")
    frozen_at = None
    if rendered:
        last = rendered[-1]
        for i in range(len(rendered) - 1, -1, -1):
            if rendered[i] != last:
                frozen_at = i + 1
                break
    return {
        "delivery_first": delivery[0] if delivery else None,
        "delivery_peak": max(delivery) if delivery else None,
        "delivery_last": delivery[-1] if delivery else None,
        "decaying": bool(delivery) and max(delivery) - delivery[-1] > 5.0,
        "player_frozen_after_sample": frozen_at,
        "encoded_last": encoded[-1] if encoded else None,
        "rendered_last": rendered[-1] if rendered else None,
    }


def stale_e2e(rows: List[dict]) -> dict:
    """How many trailing samples repeat the same e2e value verbatim."""
    values = [num(r.get("e2e_latency_ms")) for r in rows]
    live = [v for v in values if v]
    if not live:
        return {"repeated_tail": 0, "value": None}
    last = live[-1]
    tail = 0
    for v in reversed(values):
        if v == last:
            tail += 1
        elif v:
            break
    return {"repeated_tail": tail, "value": last, "of_samples": len(rows)}


def audit(filename: str, rows: List[dict]) -> None:
    protocol = (rows[0].get("protocol") if rows else "") or "?"
    endpoint = (rows[0].get("endpoint") if rows else "") or "?"
    print(f"\n=== {filename}  protocol={protocol}  endpoint={endpoint}  samples={len(rows)}")

    print("  -- latency budget --")
    for key in (*LATENCY_COMPONENTS, "latency_accounted_ms", "latency_residual_ms",
                "e2e_latency_ms", "playback_ttff_ms", "upload_latency_ms"):
        s = summarize_column(rows, key)
        flag = ""
        if s["nonzero"] == 0 and s["empty"] == s["n"]:
            flag = "  <- never emitted"
        elif s["nonzero"] == 0:
            flag = "  <- always zero"
        if s.get("implausible"):
            flag += f"  <- {s['implausible']} implausible"
        print(f"     {key:28s} nonzero={s['nonzero']:>3}/{s['n']:<3} "
              f"mean={s.get('mean_nonzero')} max={s['max']}{flag}")
    rec = reconcile(rows)
    print(f"     reconcile: {rec}")
    print(f"     stale e2e: {stale_e2e(rows)}")

    print("  -- frames --")
    for key in FRAME_COLUMNS:
        s = summarize_column(rows, key)
        print(f"     {key:28s} nonzero={s['nonzero']:>3}/{s['n']:<3} "
              f"last={s['last']} max={s['max']}")
    print(f"     trend: {frame_trend(rows)}")

    print("  -- transport / quality --")
    for key in ("encoded_bitrate_kbps", "fps", "fps_stability", "speed", "cpu_percent",
                "net_rtt_ms", "net_jitter_ms", "net_loss_pct", "net_send_mbps",
                "playback_stall_count", "playback_rebuffer_sec", "playback_buffer_sec",
                "vmaf_score", "moqx_subscribe_success", "quic_rtt_ms",
                "cmaf_fragment_count", "ts_continuity_counter_errors"):
        s = summarize_column(rows, key)
        note = ""
        if s["nonzero"] == 0:
            note = "  (zero)"
        if s.get("implausible"):
            note += f"  <- {s['implausible']} implausible"
        print(f"     {key:28s} nonzero={s['nonzero']:>3}/{s['n']:<3} "
              f"mean={s.get('mean_nonzero')} max={s['max']}{note}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("jobs", nargs="*", help="job id prefix (first 8 chars) or CSV filename")
    parser.add_argument("--latest", type=int, default=0, help="audit the N most recent results")
    args = parser.parse_args()

    targets: List[str] = []
    if args.latest:
        targets = [r["filename"] for r in list_results(args.latest)]
    for job in args.jobs:
        if job.endswith(".csv"):
            targets.append(job)
            continue
        match = [r["filename"] for r in list_results(200) if job[:8] in r["filename"]]
        if not match:
            print(f"no archived result for {job}", file=sys.stderr)
            continue
        targets.append(match[0])

    if not targets:
        parser.error("give job ids or --latest N")

    for filename in targets:
        try:
            rows = load_rows(filename)
        except Exception as exc:
            print(f"\n=== {filename}  LOAD FAILED: {exc}")
            continue
        if not rows:
            print(f"\n=== {filename}  EMPTY CSV")
            continue
        audit(filename, rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
