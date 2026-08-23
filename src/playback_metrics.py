"""Browser playback metrics merged into benchmark CSV/summary after a run."""
import csv
import json
import logging
from typing import Dict, List, Optional

logger = logging.getLogger("MoQ-SRT-Bench")

PLAYBACK_FIELD_NAMES = [
    "playback_stats_events",
    "playback_stall_count",
    "playback_frames_rendered",
    "playback_frames_dropped",
    "playback_bitrate_bps",
    "playback_ttff_ms",
    "playback_hls_errors",
    "playback_hls_fatal_errors",
    "playback_hls_buffer_stalls",
    "playback_hls_frag_loads",
    "playback_video_time_sec",
    "playback_buffer_sec",
    # Seconds the glass is BEHIND live. MoQ LOC only, and the opposite
    # direction from playback_buffer_sec (which is seconds queued AHEAD).
    # Kept in its own column precisely so it can never be summed into the
    # player-buffer stage of the latency chain.
    "playback_behind_live_sec",
    "playback_rebuffer_sec",
    "playback_error_count",
    "e2e_latency_ms",
    # Startup decomposition, player half (see src/startup_budget.py). Kept in
    # PLAYBACK_NULLABLE_KEYS below, which is what stops them being coerced.
    "startup_player_request_ms",
    "startup_manifest_ms",
    "startup_first_media_ms",
    "startup_first_paint_ms",
]

# Columns where blank and 0 mean different things, so they must not pass
# through _as_float(x or 0) / a "0" default like every other playback column.
#
# A startup phase reports the duration of one stage of the join. 0.0 means
# "measured, and it completed inside the measurement resolution"; blank means
# "nothing on this engine measures this stage" — a raw MPEG-TS pull has no
# manifest at all, and Resource Timing zeroes every interior mark on a
# cross-origin response without Timing-Allow-Origin. Defaulting either case to
# 0 would report the phase as measured and free, which is precisely the
# misattribution the startup family exists to expose: the residual would shrink
# to match a stage nothing had actually observed.
PLAYBACK_NULLABLE_KEYS = (
    "startup_player_request_ms",
    "startup_manifest_ms",
    "startup_first_media_ms",
    "startup_first_paint_ms",
)

PLAYBACK_NUMERIC_FIELD_NAMES = [
    name for name in PLAYBACK_FIELD_NAMES if name not in PLAYBACK_NULLABLE_KEYS
]

PLAYBACK_DEFAULTS = {name: "0" for name in PLAYBACK_NUMERIC_FIELD_NAMES}

# Columns the encoder loop can only write provisionally: they depend on
# playback counters (buffer, e2e, rendered/dropped frames) that arrive from the
# browser after the row was flushed. Recomputed from merged values below so the
# persisted CSV is self-consistent instead of holding a stale zero.
PLAYBACK_DERIVED_FIELD_NAMES = [
    "latency_player_buffer_ms",
    "latency_accounted_ms",
    "latency_residual_ms",
    "latency_overcount_ms",
    "latency_unmeasured",
    "latency_e2e_scope",
    "playback_frame_drop_pct",
    "frame_delivery_pct",
    "playback_sample_age_sec",
]

PLAYBACK_GAUGE_KEYS = (
    "playback_bitrate_bps",
    "playback_ttff_ms",
    "playback_video_time_sec",
    "playback_buffer_sec",
    "playback_behind_live_sec",
    "e2e_latency_ms",
)

# Instantaneous gauges that describe "what the player is doing right now".
# Once the player stops reporting these are no longer measurements, so they
# are blanked rather than forward-filled — a repeated value made a detached
# leg look rock-steady (Linode WebRTC repeated one e2e for 22 of 30 samples,
# Zixi RTMP for 24 of 30) and dragged the mean toward whatever the last live
# reading happened to be. playback_ttff_ms is excluded on purpose: a join
# time is a fact about the run, not a live gauge — and so are the startup
# phases that decompose it, which is why PLAYBACK_NULLABLE_KEYS is absent here.
# Blanking them once the player detaches would erase the only record of how the
# join was spent from every row after it.
PLAYBACK_LIVE_GAUGE_KEYS = (
    "playback_bitrate_bps",
    "playback_video_time_sec",
    "playback_buffer_sec",
    "playback_behind_live_sec",
    "e2e_latency_ms",
)

# The browser reports every 1s (playbackMetrics.REPORT_INTERVAL_MS). Two
# missed reports is a detached or dead player, not jitter.
PLAYBACK_STALE_AFTER_SEC = 3

PLAYBACK_COUNTER_KEYS = (
    "playback_stats_events",
    "playback_stall_count",
    "playback_frames_rendered",
    "playback_frames_dropped",
    "playback_hls_errors",
    "playback_hls_fatal_errors",
    "playback_hls_buffer_stalls",
    "playback_hls_frag_loads",
    "playback_error_count",
)


def _row_elapsed_sec(rows: List[dict], index: int) -> int:
    if not rows:
        return index
    try:
        first_ts = float(rows[0].get("timestamp", 0) or 0)
        row_ts = float(rows[index].get("timestamp", 0) or 0)
        if first_ts > 0 and row_ts > 0:
            return max(0, int(round(row_ts - first_ts)))
    except (TypeError, ValueError):
        pass
    return index


def _playback_by_elapsed(playback_samples: List[dict]) -> Dict[int, dict]:
    by_sec: Dict[int, dict] = {}
    for sample in playback_samples:
        try:
            elapsed = int(sample.get("elapsed_sec", -1))
        except (TypeError, ValueError):
            continue
        if elapsed < 0:
            continue
        incoming = {name: sample.get(name, 0) for name in PLAYBACK_NUMERIC_FIELD_NAMES}
        # No `, 0` default here: a phase the browser did not report stays None
        # all the way to the CSV.
        incoming.update(
            {name: _nullable_float(sample.get(name)) for name in PLAYBACK_NULLABLE_KEYS}
        )
        previous = by_sec.get(elapsed)
        if previous:
            incoming = _playback_high_water(previous, incoming)
        by_sec[elapsed] = incoming
    return by_sec


def _as_float(value: object) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _nullable_float(value: object) -> Optional[float]:
    """Milliseconds, or None. Keeps "no reading" apart from a reading of 0.

    Deliberately not _as_float: that helper folds None, "" and unparseable
    input into 0.0, which for a startup phase is the difference between
    "nothing measures this" and "this was instant".
    """
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return number


def _csv_number(value: object) -> str:
    number = _as_float(value)
    if number.is_integer():
        return str(int(number))
    return str(number)


def _csv_nullable(value: Optional[float]) -> str:
    """Blank for no reading; one decimal otherwise, matching startup_budget."""
    return "" if value is None else f"{float(value):.1f}"


def _playback_high_water(dest: dict, incoming: dict) -> dict:
    """Do not let a reconnect snapshot of zeros erase painted-glass counters."""
    merged = dict(dest)
    for name in PLAYBACK_COUNTER_KEYS:
        merged[name] = max(_as_float(dest.get(name)), _as_float(incoming.get(name)))
    for name in PLAYBACK_GAUGE_KEYS:
        value = _as_float(incoming.get(name))
        if value > 0:
            merged[name] = value
    for name in PLAYBACK_NULLABLE_KEYS:
        # First non-null wins. These describe a single join, so the earliest
        # reading is the one that describes it — a later sample carries the
        # same values (or nulls, after a reconnect restarts the chain) and must
        # not overwrite them. max() is wrong here twice over: it would treat a
        # missing reading as 0, and it would prefer the largest phase seen
        # across reconnects rather than the phases of the join that happened.
        existing = _nullable_float(dest.get(name))
        merged[name] = existing if existing is not None else _nullable_float(incoming.get(name))
    return merged


def _unmeasured_from_row(row: dict) -> set:
    """Re-read the stage names the encoder loop already marked unmeasured."""
    from latency_budget import LATENCY_COMPONENTS, STAGE_NAMES

    by_stage = dict(zip(STAGE_NAMES, LATENCY_COMPONENTS))
    names = str(row.get("latency_unmeasured", "") or "").split(",")
    return {by_stage[name] for name in (n.strip() for n in names) if name in by_stage}


def _recompute_derived(
    row: dict,
    *,
    engine: str = "",
    encode_frames_at_attach: Optional[float] = None,
    playback_frames_at_attach: Optional[float] = None,
    encode_frames_at_report: Optional[float] = None,
    playback_live: bool = True,
) -> None:
    """Refresh latency/frame columns that depend on merged playback values.

    Only rows that already carry the encoder-side columns are touched, so CSVs
    written before the latency decomposition existed pass through unchanged.

    ``playback_live`` is False once the player has stopped reporting. The
    player-side stages are then *unmeasured* for that row rather than zero,
    which is what stops a detached player from being charted as a 0 ms buffer
    against a forward-filled glass delay.
    """
    if "latency_accounted_ms" not in row:
        return
    from latency_budget import (
        LatencyBudget,
        e2e_scope_for,
        frame_delivery_pct,
        playback_frame_drop_pct,
        player_buffer_latency_ms,
    )

    unmeasured = _unmeasured_from_row(row)
    # Strictly seconds queued AHEAD of the playhead. MoQ LOC's "behind live"
    # seconds arrive in playback_behind_live_sec and are deliberately not
    # consulted here — they are the opposite direction and summing them
    # charted a 10.9s "buffer" on the lowest-latency protocol.
    buffer_sec = _as_float(row.get("playback_buffer_sec"))
    player_buffer_ms = player_buffer_latency_ms(playback_buffer_sec=buffer_sec)
    if not playback_live:
        unmeasured.add("latency_player_buffer_ms")
        player_buffer_ms = 0.0

    budget = LatencyBudget(
        encode_ms=_as_float(row.get("latency_encode_ms")),
        publish_ms=_as_float(row.get("latency_publish_ms")),
        network_ms=_as_float(row.get("latency_network_ms")),
        packager_ms=_as_float(row.get("latency_packager_ms")),
        player_buffer_ms=player_buffer_ms,
        e2e_ms=_as_float(row.get("e2e_latency_ms")),
        e2e_scope=e2e_scope_for(row.get("protocol"), engine),
        unmeasured=frozenset(unmeasured),
    )
    row["latency_player_buffer_ms"] = f"{budget.player_buffer_ms:.1f}"
    row["latency_accounted_ms"] = f"{budget.accounted_ms:.1f}"
    row["latency_residual_ms"] = f"{budget.residual_ms:.1f}"
    row["latency_overcount_ms"] = f"{budget.overcount_ms:.1f}"
    row["latency_unmeasured"] = ",".join(budget.unmeasured_stages)
    row["latency_e2e_scope"] = budget.e2e_scope
    row["playback_frame_drop_pct"] = (
        f"{playback_frame_drop_pct(frames_rendered=_as_float(row.get('playback_frames_rendered')), frames_dropped=_as_float(row.get('playback_frames_dropped'))):.3f}"
    )
    # Only comparable while the player is still counting: once it detaches the
    # encoder keeps incrementing and the ratio decays with nothing lost.
    #
    # Both counters must come from the same instant. The player's value is
    # forward-filled across the staleness grace window, so pairing it with a
    # live encoder total divides a frozen numerator by a growing denominator
    # and manufactures a decay: RTMP read 100.00 -> 66.67 -> 50.00 -> 40.00
    # while the player sat at 73 rendered and nothing was actually lost.
    # Forward-filling is safe for a gauge and wrong for a ratio of two
    # counters, so the encoder total is pinned to its value at the player's
    # last report and the ratio holds flat until the player reports again.
    delivery = (
        frame_delivery_pct(
            encode_frames_total=(
                _as_float(row.get("encode_frames_total"))
                if encode_frames_at_report is None
                else encode_frames_at_report
            ),
            playback_frames_rendered=_as_float(row.get("playback_frames_rendered")),
            encode_frames_at_attach=encode_frames_at_attach,
            playback_frames_at_attach=playback_frames_at_attach,
        )
        if playback_live
        else None
    )
    row["frame_delivery_pct"] = "" if delivery is None else f"{delivery:.2f}"


def merge_playback_into_csv(
    csv_path: str,
    playback_samples: List[dict],
    *,
    csv_columns: List[str],
    playback_engine: str = "",
) -> List[dict]:
    """Return updated rows with playback columns filled by elapsed_sec."""
    if not playback_samples:
        return []

    with open(csv_path, mode="r", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)

    if not rows:
        return []

    by_sec = _playback_by_elapsed(playback_samples)
    if not by_sec:
        return rows

    last_values = dict(PLAYBACK_DEFAULTS)
    # Carried separately from last_values because their default is "no reading",
    # which PLAYBACK_DEFAULTS cannot express.
    last_nullable: Dict[str, Optional[float]] = {name: None for name in PLAYBACK_NULLABLE_KEYS}
    updated: List[dict] = []
    # Merge nearest-at-or-before: playback ticks and CSV rows rarely share the
    # exact integer second (different loop phases), and requiring equality
    # left every playback_*/e2e column at 0. Forward-fill the latest playback
    # sample at-or-before each row's elapsed time instead.
    sorted_secs = sorted(by_sec)
    last_playback_sec: Optional[int] = None
    # Both frame counters when the player attached. They are cumulative from
    # different zero points, so differencing against these is what puts them
    # on one common window (see latency_budget.frame_delivery_pct).
    encode_frames_at_attach: Optional[float] = None
    playback_frames_at_attach: Optional[float] = None
    # Encoder total as of the player's most recent report, so the delivery
    # ratio always pairs two co-temporal counters (see _recompute_derived).
    encode_frames_at_report: Optional[float] = None
    cursor = 0
    for index, row in enumerate(rows):
        elapsed = _row_elapsed_sec(rows, index)
        while cursor < len(sorted_secs) and sorted_secs[cursor] <= elapsed:
            last_playback_sec = sorted_secs[cursor]
            carried: dict = {
                name: _as_float(last_values[name]) for name in PLAYBACK_NUMERIC_FIELD_NAMES
            }
            carried.update(last_nullable)
            combined = _playback_high_water(carried, by_sec[sorted_secs[cursor]])
            last_values = {
                name: _csv_number(combined[name]) for name in PLAYBACK_NUMERIC_FIELD_NAMES
            }
            last_nullable = {
                name: _nullable_float(combined.get(name)) for name in PLAYBACK_NULLABLE_KEYS
            }
            cursor += 1
        age = None if last_playback_sec is None else max(0, elapsed - last_playback_sec)
        playback_live = age is not None and age <= PLAYBACK_STALE_AFTER_SEC

        merged = dict(row)
        merged.update(last_values)
        # Blank-preserving, and outside the live-gauge blanking below: a join
        # already happened, so its phases stay on every later row.
        merged.update({name: _csv_nullable(value) for name, value in last_nullable.items()})
        if not playback_live:
            # Distinguish "steady" from "no longer being measured".
            for name in PLAYBACK_LIVE_GAUGE_KEYS:
                merged[name] = ""
        merged["playback_sample_age_sec"] = "" if age is None else str(age)
        if (
            encode_frames_at_attach is None
            and playback_live
            and _as_float(merged.get("playback_frames_rendered")) > 0
        ):
            encode_frames_at_attach = _as_float(merged.get("encode_frames_total"))
            playback_frames_at_attach = _as_float(merged.get("playback_frames_rendered"))
        if age == 0:
            encode_frames_at_report = _as_float(merged.get("encode_frames_total"))
        _recompute_derived(
            merged,
            engine=playback_engine,
            encode_frames_at_attach=encode_frames_at_attach,
            playback_frames_at_attach=playback_frames_at_attach,
            encode_frames_at_report=encode_frames_at_report,
            playback_live=playback_live,
        )
        updated.append(merged)

    fieldnames = list(csv_columns)
    for name in (*PLAYBACK_FIELD_NAMES, *PLAYBACK_DERIVED_FIELD_NAMES):
        if name not in fieldnames:
            fieldnames.append(name)

    with open(csv_path, mode="w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(updated)

    return updated


def compute_playback_averages(rows: List[dict]) -> Dict[str, object]:
    if not rows:
        return {}

    averages: Dict[str, object] = {}
    count = len(rows)

    for key in PLAYBACK_GAUGE_KEYS:
        if key not in rows[0]:
            continue
        # Blank means "the player was not reporting for this sample". Counting
        # those as 0 pulls a gauge toward zero for however long the player was
        # detached, which is the mirror image of the forward-fill bug.
        live_rows = [row for row in rows if str(row.get(key, "")).strip() != ""]
        values = [float(row.get(key, 0) or 0) for row in live_rows]
        if key == "e2e_latency_ms":
            stats = robust_e2e_stats(values)
            if stats:
                averages[key] = round(stats["avg"], 3)
                averages["e2e_latency_max_ms"] = round(stats["max"], 3)
                averages["e2e_latency_samples"] = len([v for v in values if v > 0])
            continue
        if any(value > 0 for value in values):
            averages[key] = round(sum(values) / max(1, len(values)), 3)

    for key in PLAYBACK_COUNTER_KEYS:
        if key not in rows[0] and key not in rows[-1]:
            continue
        value = max(int(float(row.get(key, 0) or 0)) for row in rows)
        if value > 0:
            averages[key] = value

    # Startup phases are one-shot join facts, so the summary reports the
    # reading itself rather than a mean over the rows that repeat it. A phase
    # nothing measured is omitted entirely — publishing it as 0 would be the
    # same lie in the summary that blank-preserving avoids in the CSV.
    for key in PLAYBACK_NULLABLE_KEYS:
        for row in rows:
            value = _nullable_float(row.get(key))
            if value is not None:
                averages[key] = round(value, 1)
                break

    # Cumulative seconds (not a plain count) — keep sub-second precision.
    rebuffer_sec = round(max(float(row.get("playback_rebuffer_sec", 0) or 0) for row in rows), 3)
    if rebuffer_sec > 0:
        averages["playback_rebuffer_sec"] = rebuffer_sec

    frames = max(float(row.get("playback_frames_rendered", 0) or 0) for row in rows)
    if frames > 0 and count > 0:
        averages["playback_fps"] = round(frames / count, 2)

    # Latency components / frame ratios: average over samples that actually
    # carry a value, so a leg that only painted for part of the run is not
    # diluted toward 0 by its dead samples.
    for key in (
        "latency_player_buffer_ms",
        "latency_accounted_ms",
        "latency_residual_ms",
        "latency_overcount_ms",
        "playback_frame_drop_pct",
        "frame_delivery_pct",
    ):
        if key not in rows[0]:
            continue
        values = [
            float(row.get(key, 0) or 0)
            for row in rows
            if str(row.get(key, "")).strip() != ""
        ]
        live = [value for value in values if value > 0]
        if live:
            averages[key] = round(sum(live) / len(live), 3)

    # Which stages had no instrument on this leg. Without this the residual is
    # just a large unexplained number; with it the operator can see that the
    # packager (Zixi: no PDT) or the network (MoQ: no RTT source) was never
    # measured, rather than measured at zero.
    #
    # Only stages unmeasured on *every* sample count. The player-side stages
    # are legitimately unmeasured before the browser attaches, and reporting a
    # stage that worked for most of the run as "unmeasured" would be its own
    # small lie.
    per_row = [
        {stage.strip() for stage in str(row.get("latency_unmeasured", "") or "").split(",")}
        for row in rows
    ]
    always = set.intersection(*per_row) if per_row else set()
    always.discard("")
    if always:
        averages["latency_unmeasured_stages"] = ",".join(sorted(always))

    return averages


E2E_MIN_MS = 8.0
# Must match glassLatency.E2E_MAX_MS. A 30s ceiling here silently discarded
# every sample from genuinely broken legs — job c49d2ef4 (WebRTC, 2026-08-22)
# reached ~37s glass delay and its summary therefore reported *no* e2e at all,
# which reads as "not measured" instead of "worst leg in the run".
E2E_MAX_MS = 180_000.0


def robust_e2e_stats(values: List[float]) -> Optional[Dict[str, float]]:
    """Trimmed mean of plausible glass-delay samples, plus the true worst case.

    ``avg`` drops zeros and single-sample freeze spikes (> 3× median) so a
    momentary stall does not dominate the run's headline number. ``max`` is
    deliberately taken *before* that trim: a metric labelled "max" must report
    the worst glass delay actually observed, not the worst delay that survived
    outlier rejection.
    """
    filtered = sorted(
        value
        for value in values
        if isinstance(value, (int, float)) and E2E_MIN_MS <= float(value) < E2E_MAX_MS
    )
    if not filtered:
        return None
    mid = len(filtered) // 2
    median = (
        float(filtered[mid])
        if len(filtered) % 2 == 1
        else (float(filtered[mid - 1]) + float(filtered[mid])) / 2.0
    )
    cap = max(median * 3.0, 5000.0)
    healthy = [value for value in filtered if value <= cap]
    pool = healthy or filtered
    return {
        "avg": sum(pool) / len(pool),
        "max": filtered[-1],
    }


# Playback engines that measure the protocol's own delivery path. Anything
# else means the player consumed a remux, so the playback columns describe the
# remux — not the protocol named in the `protocol` column.
_NATIVE_PLAYBACK_ENGINES = {
    "webrtc": {"whep"},
    "moq": {"moq"},
    "srt": {"mpegts", "hls", "ll-hls", "dash"},
    "rtmp": {"mpegts", "hls", "ll-hls", "dash"},
    "hls": {"hls", "ll-hls", "mpegts"},
    "dash": {"dash"},
    "http": {"mpegts", "hls", "ll-hls", "dash"},
}


def playback_engine_caveat(protocol: str, playback_engine: str) -> str:
    """Warn when playback metrics do not describe the published protocol.

    Job c49d2ef4 (2026-08-22) is the motivating case: it is tagged
    ``protocol=webrtc`` but the tile played the LL-HLS remux of the WHIP
    ingest, so its TTFF, stalls, rebuffer and e2e were HLS numbers being
    compared against other legs as if they were WebRTC. Without this flag the
    CSV gives no hint that the comparison is invalid.
    """
    proto = (protocol or "").strip().lower()
    engine = (playback_engine or "").strip().lower()
    if not proto or not engine:
        return ""
    native = _NATIVE_PLAYBACK_ENGINES.get(proto)
    if not native or engine in native:
        return ""
    return (
        f"Playback metrics were measured with the '{engine}' player, which is not "
        f"{proto.upper()}'s own delivery path. TTFF, stalls, rebuffer and glass delay "
        f"describe that remux, not {proto.upper()} — do not compare them directly "
        "against legs played on their native path."
    )


def patch_summary_with_playback(
    summary_path: str,
    playback_samples: List[dict],
    *,
    playback_engine: str = "",
) -> None:
    if not playback_samples or not summary_path:
        return

    try:
        with open(summary_path, mode="r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read summary for playback merge: %s", exc)
        return

    csv_path = payload.get("csv_path", "")
    if not csv_path:
        return

    from metrics import CSV_COLUMNS

    rows = merge_playback_into_csv(
        csv_path,
        playback_samples,
        csv_columns=CSV_COLUMNS,
        playback_engine=playback_engine,
    )
    playback_averages = compute_playback_averages(rows)
    if not playback_averages:
        return

    averages = payload.setdefault("averages", {})
    averages.update(playback_averages)

    extra = payload.setdefault("extra", {})
    extra["playback_metrics_enabled"] = True
    if playback_engine:
        extra["playback_engine"] = playback_engine
        caveat = playback_engine_caveat(payload.get("protocol", ""), playback_engine)
        if caveat:
            extra["playback_engine_caveat"] = caveat
    extra["playback_sample_count"] = len(playback_samples)

    with open(summary_path, mode="w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
