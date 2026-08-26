#!/usr/bin/env python3
"""Per-metric health audit for finished benchmark jobs.

The matrix harnesses answer "did the leg run"; this answers "is every column
in that leg's CSV telling the truth". For each job it reports, per column,
whether the value is populated / zero / empty, whether a zero is the honest
answer for that protocol or a collection failure, and whether the latency
components reconcile with the measured end-to-end number.

Three checks are worth calling out because they cannot be seen in a single
sample:

* ``latency_residual_ms`` only reports *under*-attribution. A model that
  over-attributes shows up in ``latency_overcount_ms``. This script recomputes
  both from the raw components so a bug in either column is still visible.
* ``frame_delivery_pct`` divides a player counter by an encoder counter. When
  the player detaches early the encoder keeps counting, so the ratio decays
  even though nothing is being lost. The script reports the trend, not just
  the mean.
* ``fps`` is cross-checked against ``encode_frames_total`` over the encoder's
  *active* window, never the whole run. Any rate derived from a counter has to
  divide by the span the counter actually covers; see ``fps_truth``.

Absence is gated, not just described. Every invariant used to be of the form
"there is data and it is wrong", which meant a column that was never collected
read as compliance — the cleanest possible verdict was also exactly what a
totally broken collector produced. Two gates close that: ``REQUIRED_NONZERO``
fails a leg whose instrumented columns went quiet, and ``PLAUSIBLE`` now
asserts instead of only printing ``<- N implausible``. The encoder ramp is the
one carve-out — a first non-zero sample covers a partial interval and reads low
by construction — so it reports as an observation.

Still descriptive rather than asserted: ``HONEST_ZEROS`` is reference data, so
the audit does not yet flag the inverse case of a protocol reporting a column
it has no business populating.

With ``--assert`` the audit stops describing and starts judging: it exits
non-zero if any of the invariants below is violated on any leg. That is the
acceptance gate for a matrix run.

Findings come out on two channels, and only one of them gates. A **failure**
means a column is lying. An **observation** means a column is telling the truth
about something that deserves a look — an encoder that genuinely oscillates, a
CMAF buffer that is genuinely deep. Both are worth printing and they have
different owners, so collapsing them into one list made a passing verdict
impossible to interpret: two of the rules here conclude "this value is large and
legitimate" and then used to fail the leg anyway.

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
    "latency_segmentation_ms",
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

# Columns a protocol is not expected to populate: a zero here is honest, not a
# collection failure. Reference data for the reader; the actionable inverse is
# REQUIRED_NONZERO below.
HONEST_ZEROS: Dict[str, tuple] = {
    "srt": ("moqx_*", "quic_*", "cmaf_*"),
    "rtmp": ("moqx_*", "quic_*", "cmaf_*", "pkt_*"),
    "webrtc": ("moqx_*", "quic_*", "cmaf_*", "pkt_*"),
    "moq": ("pkt_*", "ts_continuity_counter_errors"),
}

# The audit's blind spot was absence. Every other rule is of the form "there is
# data and it is wrong", so a column that was never collected read as
# compliance — the cleanest possible verdict was also exactly what a totally
# broken collector would produce. These are the columns whose silence on a
# given protocol is a collection failure rather than an honest zero.
_CORE_REQUIRED = (
    "encode_frames_total",
    "fps",
    "encoded_bitrate_kbps",
    "cpu_percent",
    "latency_encode_ms",
)
REQUIRED_NONZERO: Dict[str, tuple] = {
    "srt": _CORE_REQUIRED + ("net_rtt_ms",),
    "rtmp": _CORE_REQUIRED + ("net_rtt_ms",),
    "webrtc": _CORE_REQUIRED + ("net_rtt_ms",),
    "http": _CORE_REQUIRED + ("net_rtt_ms",),
    # MoQ has no RTT source wired for the openmoq publisher, which is why
    # quic_rtt_ms reads 0 for the same reason (docs/METRICS.md). Requiring it
    # would fail every MoQ leg for a gap already tracked as known-unmeasured,
    # so it stays out until an instrument exists.
    "moq": _CORE_REQUIRED,
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

# D8b. Beyond this the two fps numbers are describing different encoders and one
# of them is wrong — but the gap alone does not say which, so it is only the
# trigger for the attribution below.
FPS_GAP_MAX = 1.5
# fps_stability is the coefficient of variation of the rate column
# (src/metrics.py). MoQ's publisher pipe applies backpressure and reads ~0.19;
# a steady SRT leg reads ~0.0006. 0.05 sits an order of magnitude clear of both
# clusters, so it distinguishes "the encoder really does oscillate, and the two
# fps numbers are both honest views of that" from "the encoder is steady and the
# numbers still disagree", which can only be a formula bug.
FPS_UNSTEADY_CV = 0.05


def fetch(path: str) -> bytes:
    with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=45) as resp:
        return resp.read()


def list_results(limit: int) -> List[dict]:
    data = json.loads(fetch("/api/results").decode())
    return (data.get("results") or [])[:limit]


def load_rows(filename: str) -> List[dict]:
    """Rows for one result: a local path if it resolves, else the archive API.

    Accepting a path is what makes a change to a formula in this file provable
    against an already-archived leg, offline and without a throwaway driver.
    """
    if os.path.exists(filename):
        with open(filename, newline="") as handle:
            return list(csv.DictReader(handle))
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
    "ingest_to_glass": ("latency_encode_ms", "latency_segmentation_ms"),
    "capture_to_ingest": ("latency_player_buffer_ms",),
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
    packaging for the residual. ``not_applicable`` is the other honest zero
    (WebRTC has no CMAF group) — the silent-zero gate must accept it too.
    """
    counts: Dict[str, int] = {}
    na_counts: Dict[str, int] = {}
    contradictions = 0
    for row in rows:
        listed = {
            stage.strip()
            for stage in (row.get("latency_unmeasured") or "").split(",")
            if stage.strip()
        }
        not_applicable = {
            stage.strip()
            for stage in (row.get("latency_not_applicable") or "").split(",")
            if stage.strip()
        }
        for stage in listed:
            counts[stage] = counts.get(stage, 0) + 1
            if (num(row.get(f"latency_{stage}_ms")) or 0.0) > 0.0:
                contradictions += 1
        for stage in not_applicable:
            na_counts[stage] = na_counts.get(stage, 0) + 1
    return {
        "stages": {k: f"{v}/{len(rows)}" for k, v in sorted(counts.items())},
        "not_applicable": {k: f"{v}/{len(rows)}" for k, v in sorted(na_counts.items())},
        "reported_while_unmeasured": contradictions,
    }


def fps_truth(rows: List[dict]) -> dict:
    """Headline fps from the frame counter versus the mean of the rate column.

    The counter is interval-independent; the rate mean over-weights short fast
    ticks. A large gap therefore has two possible causes, and ``stability_mean``
    is what separates them: an encoder that genuinely oscillates makes both
    numbers honest, while a steady encoder means one of the two is broken.

    The counter is divided by the encoder's **active** window — first to last
    sample carrying a live frame count — and the pair is read row-aligned. The
    earlier version took the numerator from the samples that had a frame count
    and the denominator from *every* sample, so the leading samples recorded
    before the encoder produced its first frame padded the divisor without
    adding to the dividend. On the 2026-08-23 RTMP leg that turned 810 frames
    in 27.0 s — exactly 30.0 fps — into 810 over 29.0 s, and the invented
    2.07 fps shortfall was then reported as an encoder defect.
    """
    live = [
        (stamp, count)
        for stamp, count in (
            (num(row.get("timestamp")), num(row.get("encode_frames_total")))
            for row in rows
        )
        if stamp is not None and count is not None and count > 0
    ]
    rates = [v for v in series(rows, "fps") if v > 0]
    stability = [v for v in series(rows, "fps_stability") if v > 0]
    counter = None
    window = None
    produced = None
    if len(live) > 1:
        window = live[-1][0] - live[0][0]
        produced = live[-1][1] - live[0][1]
        if window > 0 and produced > 0:
            counter = round(produced / window, 3)
    rate_mean = sum(rates) / len(rates) if rates else None
    return {
        "counter_fps": counter,
        "rate_mean_fps": round(rate_mean, 3) if rate_mean else None,
        "gap": round(abs(rate_mean - counter), 3) if rate_mean and counter else None,
        # Reported even when counter_fps could not be derived (a counter that
        # resets mid-leg yields produced <= 0), so a skipped check is visible
        # rather than looking like a pass.
        "active_window_sec": round(window, 3) if window is not None else None,
        "frames_produced": produced,
        "active_samples": f"{len(live)}/{len(rows)}",
        # Coefficient of variation of the rate column (src/metrics.py). This is
        # what separates a genuinely unsteady encoder from a broken formula.
        "stability_mean": round(sum(stability) / len(stability), 4)
        if stability
        else None,
    }


def frame_trend(rows: List[dict]) -> dict:
    delivery = series(rows, "frame_delivery_pct")
    encoded = series(rows, "encode_frames_total")
    # Row-aligned, like fps_truth: an index into the blank-filtered list is not a
    # sample number, and this figure is quoted as one. Advancing at the very
    # first sample counts as frozen from the start rather than never frozen.
    rendered_by_row = [num(row.get("playback_frames_rendered")) for row in rows]
    rendered = [v for v in rendered_by_row if v is not None]
    frozen_at = None
    if rendered:
        last = rendered[-1]
        frozen_at = next(
            (i for i, v in enumerate(rendered_by_row) if v is not None and v == last),
            None,
        )
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


def encoder_stalls(rows: List[dict], min_sec: float = 1.0) -> List[dict]:
    """Spans where the frame counter stopped advancing mid-run.

    Not the same thing as a slow encoder: the counter is frozen, so nothing was
    produced for the span at all. Samples before the first frame and any freeze
    still in progress when the run ends are excluded — a leading idle period is
    startup and a trailing one is shutdown, and neither is a stall.

    This exists because ``fps_stability`` cannot see a stall. It is the
    coefficient of variation of the rate column, and a full stop enters that
    column as a 0 that gets filtered out before the CV is taken, so a hard
    freeze reads as *steadier* than a mild wobble. On
    upload_20260823-022938_72699c63 the encoder froze 2.9s with ``fps`` at 0.00
    and ``fps_stability`` still read 0.0305, so the audit called a stall-shaped
    gap a formula defect.
    """
    live = [
        (stamp, count)
        for stamp, count in (
            (num(row.get("timestamp")), num(row.get("encode_frames_total")))
            for row in rows
        )
        if stamp is not None and count is not None and count > 0
    ]
    out: List[dict] = []
    frozen_from: Optional[float] = None
    for (t0, f0), (t1, f1) in zip(live, live[1:]):
        if f1 == f0:
            if frozen_from is None:
                frozen_from = t0
        elif frozen_from is not None:
            span = t1 - frozen_from
            if span >= min_sec:
                out.append({"at": round(frozen_from, 3), "sec": round(span, 3), "frames": f0})
            frozen_from = None
    return out


def check_invariants(rows: List[dict], protocol: str) -> tuple[List[str], List[str]]:
    """The properties every leg must now satisfy. Empty failures means clean.

    Each entry corresponds to a defect found in the 2026-08-22 matrix; a
    regression re-opens exactly one of them.

    Returns ``(failures, observations)``. Only failures gate ``--assert``. The
    split exists because two rules here reach a conclusion of the form "this
    number is large and the reason is legitimate" — an oscillating encoder, a
    deep CMAF buffer — and a rule that has already decided the metric is honest
    must not also fail the leg. Reporting those as failures made the verdict
    mean "something is large" instead of "a metric is lying", which is the one
    thing the verdict has to mean to be worth gating a matrix run on.
    """
    failures: List[str] = []
    observations: List[str] = []
    rec = reconcile(rows)
    trend = frame_trend(rows)
    unm = unmeasured_stages(rows)
    stale = stale_e2e(rows)
    fps = fps_truth(rows)
    stalls = encoder_stalls(rows)

    # An encoder that stops mid-run is worth surfacing on its own, not only as
    # the explanation for some other number. Nothing else reports it: the frame
    # counter simply resumes, encode_frames_dropped stays 0 because ffmpeg did
    # not drop anything it had, and fps_stability cannot see a full stop.
    if stalls:
        worst = max(stalls, key=lambda s: s["sec"])
        total = round(sum(s["sec"] for s in stalls), 3)
        observations.append(
            f"encoder stalled {len(stalls)} time(s) for {total}s total, longest "
            f"{worst['sec']}s frozen at {worst['frames']:.0f} frames — the frame "
            f"counter stopped advancing mid-run while the leg kept going. "
            f"encode_frames_dropped stays 0 because nothing was dropped, it was "
            f"never produced"
        )

    # Absence gate. A required column that never arrived is a broken collector,
    # and until now it produced the same "invariants OK" as a healthy leg.
    for column in REQUIRED_NONZERO.get(protocol, _CORE_REQUIRED):
        if column.startswith("latency_"):
            stage = column[len("latency_") : -len("_ms")]
            if unm["stages"].get(stage) or unm.get("not_applicable", {}).get(stage):
                continue
        s = summarize_column(rows, column)
        if s["nonzero"] == 0:
            state = "never emitted" if s["empty"] == s["n"] else "zero on every sample"
            failures.append(
                f"{column} is {state} on a {protocol} leg that instruments it — "
                f"a required column going quiet is a collection failure, and "
                f"reading it as an honest zero is how a broken collector passes"
            )

    # Plausibility gate. PLAUSIBLE has always been computed and printed as
    # "<- N implausible", and never gated, so a value outside its own sanity
    # window did not cost the leg anything. The encoder ramp is the one honest
    # exception: the first non-zero sample covers a partial interval, which is
    # why the 2026-08-23 MoQ leg opens at 10.6 kbps before settling above 2900.
    for column, (low, high) in PLAUSIBLE.items():
        values = series(rows, column)
        nonzero_idx = [i for i, v in enumerate(values) if v != 0.0]
        if not nonzero_idx:
            continue
        ramp = nonzero_idx[0]
        bad = [(i, v) for i, v in enumerate(values) if v != 0.0 and not low <= v <= high]
        if not bad:
            continue
        sustained = [(i, v) for i, v in bad if i != ramp]
        if sustained:
            failures.append(
                f"{column} leaves its plausible window [{low}, {high}] on "
                f"{len(sustained)} sample(s) past the encoder ramp (e.g. "
                f"{sustained[0][1]}) — that far out is a formula or unit error, "
                f"not a measurement"
            )
        else:
            observations.append(
                f"{column} reads {bad[0][1]} on its first non-zero sample, under "
                f"the plausible floor {low} — a partial interval at encoder "
                f"start, not sustained"
            )

    if rec["accounted_mismatch"]:
        failures.append(
            f"latency_accounted_ms disagrees with its components on "
            f"{rec['accounted_mismatch']} samples (scope-aware sum)"
        )
    # Over-attribution is now reportable, so it must actually be reported.
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
            na_listed = unm.get("not_applicable", {}).get(stage)
            if not listed and not na_listed:
                failures.append(
                    f"{component} is 0 on every sample but '{stage}' is absent "
                    f"from latency_unmeasured and latency_not_applicable — "
                    f"a silent zero"
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

    # Defect 8b: headline fps must track the frame counter. The gap on its own
    # is not a verdict — fps_truth's own docstring says a large gap can mean the
    # encoder is oscillating — so fps_stability decides what the finding says.
    # Reporting startup oscillation as a formula defect sent one investigation
    # after a bug that did not exist; the two cases need different owners.
    if fps["counter_fps"] and fps["gap"] and fps["gap"] > FPS_GAP_MAX:
        cv = fps["stability_mean"]
        observed = (
            f"rate-mean {fps['rate_mean_fps']} vs counter-derived "
            f"{fps['counter_fps']} ({fps['frames_produced']:.0f} frames over a "
            f"{fps['active_window_sec']}s active window), gap {fps['gap']}"
        )
        # A stall explains the gap before fps_stability gets a vote, because
        # fps_stability is structurally blind to one: a full stop is a zero,
        # and the zeros are filtered out before the CV is taken. The rate mean
        # skips those samples too, while the counter spans them — so the two
        # numbers disagree by exactly the stall, and both are honest.
        if stalls:
            observations.append(
                f"fps gap explained by the stall above: {observed}. The rate mean "
                f"skips the zero samples and the counter spans them, so the two "
                f"disagree by roughly the stall and both are honest — "
                f"fps_stability {cv} does not catch it because a full stop is a "
                f"zero, not a wobble"
            )
        elif cv is None:
            failures.append(
                f"fps gap unattributed: {observed}; fps_stability is absent, so "
                f"the audit cannot tell an oscillating encoder from a bad formula"
            )
        elif cv >= FPS_UNSTEADY_CV:
            observations.append(
                f"unstable encode: {observed}; fps_stability {cv} >= "
                f"{FPS_UNSTEADY_CV} means the encoder throughput genuinely "
                f"oscillates, so both numbers are honest — a product "
                f"observation, not a metric formula defect"
            )
        else:
            failures.append(
                f"fps formula defect: {observed}; fps_stability {cv} < "
                f"{FPS_UNSTEADY_CV} means the encoder was steady, so two fps "
                f"numbers this far apart cannot both be right"
            )

    if protocol == "moq":
        # Defect 6: LOC "behind live" seconds must not land in the buffer stage.
        #
        # The first form of this rule inferred the leak from the buffer alone,
        # because it read "MoQ" as "the LOC canvas". MoQ is also the CMAF/MSE
        # path, which owns a real HTMLMediaElement and can hold a genuinely deep
        # buffered range. On 2026-08-23 that inference failed a leg whose
        # playback_behind_live_sec was 0.0 on every row while
        # cmaf_fragment_count climbed 2 -> 59: the 7134ms was real buffered
        # media and the audit named a cause its own CSV contradicted.
        #
        # Both quantities are archived now, so stop inferring. A leak is the
        # buffer stage *carrying the behind-live number*, and that is decidable.
        buffers = series(rows, "latency_player_buffer_ms")
        peak = max(buffers) if buffers else 0.0
        if peak > 3000.0:
            behind = series(rows, "playback_behind_live_sec")
            leaked_ms = (max(behind) if behind else 0.0) * 1000.0
            fragments = series(rows, "cmaf_fragment_count")
            is_cmaf = bool(fragments) and max(fragments) > 0
            if leaked_ms and abs(peak - leaked_ms) <= max(250.0, 0.05 * leaked_ms):
                failures.append(
                    f"latency_player_buffer_ms peaks at {peak:.0f}ms on MoQ and "
                    f"playback_behind_live_sec peaks at {leaked_ms / 1000.0:.3f}s "
                    f"— behind-live seconds are leaking into the buffer stage"
                )
            elif is_cmaf:
                observations.append(
                    f"latency_player_buffer_ms peaks at {peak:.0f}ms on MoQ, but "
                    f"this leg is CMAF/MSE (cmaf_fragment_count reaches "
                    f"{max(fragments):.0f}) and playback_behind_live_sec stays at "
                    f"{(max(behind) if behind else 0.0):.3f}s — a real buffered "
                    f"range, not a leak. Deep for a low-latency transport, so it "
                    f"is worth an owner, but the metric is telling the truth"
                )
            else:
                failures.append(
                    f"latency_player_buffer_ms peaks at {peak:.0f}ms on a MoQ leg "
                    f"with no CMAF fragments, so there is no HTMLMediaElement to "
                    f"hold that buffer and no behind-live value to explain it"
                )
    return failures, observations


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

    failures, observations = check_invariants(rows, protocol)
    if observations:
        print("  -- observations (honest metrics, product-side owners) --")
        for line in observations:
            print(f"     ~ {line}")
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
