#!/usr/bin/env python3
"""Per-metric health audit for finished benchmark jobs.

The matrix harnesses answer "did the leg run"; this answers "is every column
in that leg's CSV telling the truth". For each job it reports, per column,
whether the value is populated / zero / empty, whether a zero is the honest
answer for that protocol or a collection failure, and whether the latency
components reconcile with the measured end-to-end number.

Two checks are worth calling out because they cannot be seen in a single
sample:

* ``latency_residual_ms`` only reports *under*-attribution. A model that
  over-attributes shows up in ``latency_overcount_ms``. This script recomputes
  both from the raw components so a bug in either column is still visible.
* ``frame_delivery_pct`` divides a player counter by an encoder counter. When
  the player detaches early the encoder keeps counting, so the ratio decays
  even though nothing is being lost. The script reports the trend, not just
  the mean.

With ``--assert`` the audit stops describing and starts judging: it exits
non-zero if any of the invariants below is violated on any leg. That is the
acceptance gate for a matrix run.

Usage:
    scripts/qa_metric_audit.py JOB8 [JOB8 ...]
    scripts/qa_metric_audit.py --latest 6
    scripts/qa_metric_audit.py --latest 6 --assert
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


# Components a given e2e scope does not span. Mirrors latency_budget._OUT_OF_SCOPE:
# a WHEP e2e is a receiver-side jitter-buffer figure that begins at ingest, so
# the sender-side encode offset is reported but must not be summed into it.
OUT_OF_SCOPE = {
    "capture_to_glass": (),
    "ingest_to_glass": ("latency_encode_ms",),
}


def reconcile(rows: List[dict]) -> dict:
    """Recompute the reconciliation from raw components, scope-aware.

    Deliberately does not trust ``latency_accounted_ms``: the point of the
    audit is to catch the case where the published column and the components
    disagree.
    """
    over = []
    under = []
    residual_share = []
    mismatched = 0
    scopes = set()
    for row in rows:
        e2e = num(row.get("e2e_latency_ms")) or 0.0
        if e2e <= 0:
            continue
        scope = (row.get("latency_e2e_scope") or "capture_to_glass").strip()
        scopes.add(scope)
        skip = OUT_OF_SCOPE.get(scope, ())
        parts = sum(
            num(row.get(c)) or 0.0 for c in LATENCY_COMPONENTS if c not in skip
        )
        accounted = num(row.get("latency_accounted_ms")) or 0.0
        if abs(parts - accounted) > 0.5:
            mismatched += 1
        signed = e2e - parts
        if signed < 0:
            over.append(-signed)
        else:
            under.append(signed)
            residual_share.append(signed / e2e * 100.0)

        # The two published halves must agree with the recomputation, and
        # exactly one of them may be non-zero.
        published_residual = num(row.get("latency_residual_ms")) or 0.0
        published_over = num(row.get("latency_overcount_ms")) or 0.0
        if published_residual > 0.5 and published_over > 0.5:
            mismatched += 1
    return {
        "samples_with_e2e": len(over) + len(under),
        "scopes": ",".join(sorted(scopes)) or "-",
        "over_attributed": len(over),
        "over_attributed_max_ms": round(max(over), 1) if over else 0.0,
        "accounted_mismatch": mismatched,
        "residual_pct_mean": round(sum(residual_share) / len(residual_share), 1)
        if residual_share
        else None,
        "residual_pct_max": round(max(residual_share), 1) if residual_share else None,
    }


def unmeasured_stages(rows: List[dict]) -> dict:
    """Which stages declared themselves instrument-less, and how consistently.

    A stage that is listed as unmeasured must not also be reporting a number:
    that combination is what made a Zixi packager read 0 while the docs blamed
    packaging for the residual.
    """
    counts: Dict[str, int] = {}
    contradictions = 0
    for row in rows:
        listed = {
            stage.strip()
            for stage in (row.get("latency_unmeasured") or "").split(",")
            if stage.strip()
        }
        for stage in listed:
            counts[stage] = counts.get(stage, 0) + 1
            if (num(row.get(f"latency_{stage}_ms")) or 0.0) > 0.0:
                contradictions += 1
    return {
        "stages": {k: f"{v}/{len(rows)}" for k, v in sorted(counts.items())},
        "reported_while_unmeasured": contradictions,
    }


def fps_truth(rows: List[dict]) -> dict:
    """Headline fps from the frame counter versus the mean of the rate column.

    The counter is interval-independent; the rate mean over-weights short fast
    ticks. A large gap means the encoder throughput is oscillating (check
    fps_stability), not that either number is broken.
    """
    stamps = series(rows, "timestamp")
    frames = [v for v in series(rows, "encode_frames_total") if v > 0]
    rates = [v for v in series(rows, "fps") if v > 0]
    counter = None
    if len(stamps) > 1 and len(frames) > 1:
        wall = max(stamps) - min(stamps)
        produced = max(frames) - min(frames)
        if wall > 0 and produced > 0:
            counter = round(produced / wall, 3)
    return {
        "counter_fps": counter,
        "rate_mean_fps": round(sum(rates) / len(rates), 3) if rates else None,
        "gap": round(abs((sum(rates) / len(rates)) - counter), 3)
        if rates and counter
        else None,
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


def check_invariants(rows: List[dict], protocol: str) -> List[str]:
    """The properties every leg must now satisfy. Empty list means clean.

    Each entry corresponds to a defect found in the 2026-08-22 matrix; a
    regression re-opens exactly one of them.
    """
    failures: List[str] = []
    rec = reconcile(rows)
    trend = frame_trend(rows)
    unm = unmeasured_stages(rows)
    stale = stale_e2e(rows)
    fps = fps_truth(rows)

    if rec["accounted_mismatch"]:
        failures.append(
            f"latency_accounted_ms disagrees with its components on "
            f"{rec['accounted_mismatch']} samples (scope-aware sum)"
        )
    # Over-attribution is now reportable, so it must actually be reported.
    over_rows = [r for r in rows if (num(r.get("latency_overcount_ms")) or 0.0) > 0.5]
    silent_over = [
        r
        for r in rows
        if (num(r.get("e2e_latency_ms")) or 0.0) > 0
        and (num(r.get("latency_accounted_ms")) or 0.0)
        - (num(r.get("e2e_latency_ms")) or 0.0)
        > 0.5
        and (num(r.get("latency_overcount_ms")) or 0.0) <= 0.5
    ]
    if silent_over:
        failures.append(
            f"{len(silent_over)} samples over-attribute without reporting "
            f"latency_overcount_ms (the clamp is back)"
        )

    if unm["reported_while_unmeasured"]:
        failures.append(
            f"{unm['reported_while_unmeasured']} samples report a number for a "
            f"stage they list as unmeasured"
        )

    # A named cost must not be silently zero: if a component reads 0 for the
    # whole leg it has to say it had no instrument.
    for component in LATENCY_COMPONENTS:
        stage = component[len("latency_"):-len("_ms")]
        values = series(rows, component)
        if values and not any(v > 0 for v in values):
            listed = unm["stages"].get(stage)
            if not listed:
                failures.append(
                    f"{component} is 0 on every sample but '{stage}' is absent "
                    f"from latency_unmeasured — a silent zero"
                )

    # Defect 2: the ratio must not decay to a fraction of its peak while the
    # player is frozen and the encoder keeps counting.
    if trend["decaying"] and trend["delivery_peak"]:
        drop = trend["delivery_peak"] - (trend["delivery_last"] or 0.0)
        if drop > 20.0:
            failures.append(
                f"frame_delivery_pct decayed {trend['delivery_peak']:.1f} -> "
                f"{trend['delivery_last']:.1f} with a frozen player (windowing lost)"
            )

    # Defect 7: a long verbatim tail means the column is being forward-filled
    # past the player's last report instead of blanked.
    if stale["repeated_tail"] >= 5 and stale.get("of_samples"):
        failures.append(
            f"e2e_latency_ms repeats {stale['value']} for the last "
            f"{stale['repeated_tail']}/{stale['of_samples']} samples (stale, not stable)"
        )

    # Defect 8: headline fps must track the frame counter.
    if fps["counter_fps"] and fps["gap"] and fps["gap"] > 1.5:
        failures.append(
            f"fps rate-mean {fps['rate_mean_fps']} is {fps['gap']} off the "
            f"counter-derived {fps['counter_fps']}"
        )

    if protocol == "moq":
        # Defect 6: LOC "behind live" seconds must not land in the buffer stage.
        buffers = series(rows, "latency_player_buffer_ms")
        if buffers and max(buffers) > 3000.0:
            failures.append(
                f"latency_player_buffer_ms peaks at {max(buffers):.0f}ms on MoQ "
                f"— LOC behind-live seconds are leaking into the buffer stage"
            )
    return failures


def audit(filename: str, rows: List[dict]) -> List[str]:
    protocol = (rows[0].get("protocol") if rows else "") or "?"
    endpoint = (rows[0].get("endpoint") if rows else "") or "?"
    print(f"\n=== {filename}  protocol={protocol}  endpoint={endpoint}  samples={len(rows)}")

    print("  -- latency budget --")
    for key in (*LATENCY_COMPONENTS, "latency_accounted_ms", "latency_residual_ms",
                "latency_overcount_ms",
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
    print(f"     reconcile:  {reconcile(rows)}")
    print(f"     unmeasured: {unmeasured_stages(rows)}")
    print(f"     stale e2e:  {stale_e2e(rows)}")

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
    print(f"     fps truth: {fps_truth(rows)}")

    failures = check_invariants(rows, protocol)
    if failures:
        print("  -- FAIL --")
        for line in failures:
            print(f"     ! {line}")
    else:
        print("  -- invariants OK --")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("jobs", nargs="*", help="job id prefix (first 8 chars) or CSV filename")
    parser.add_argument("--latest", type=int, default=0, help="audit the N most recent results")
    parser.add_argument(
        "--assert",
        dest="assert_clean",
        action="store_true",
        help="exit non-zero if any leg violates a metric invariant",
    )
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

    failed: Dict[str, List[str]] = {}
    for filename in targets:
        try:
            rows = load_rows(filename)
        except Exception as exc:
            print(f"\n=== {filename}  LOAD FAILED: {exc}")
            failed[filename] = [f"load failed: {exc}"]
            continue
        if not rows:
            print(f"\n=== {filename}  EMPTY CSV")
            failed[filename] = ["empty csv"]
            continue
        problems = audit(filename, rows)
        if problems:
            failed[filename] = problems

    print(f"\n=== verdict: {len(targets) - len(failed)}/{len(targets)} legs clean")
    for filename, problems in failed.items():
        print(f"  {filename}: {len(problems)} issue(s)")
    if failed and args.assert_clean:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
