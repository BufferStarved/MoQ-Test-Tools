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
    "playback_rebuffer_sec",
    "playback_error_count",
    "e2e_latency_ms",
]

PLAYBACK_DEFAULTS = {name: "0" for name in PLAYBACK_FIELD_NAMES}

# Columns the encoder loop can only write provisionally: they depend on
# playback counters (buffer, e2e, rendered/dropped frames) that arrive from the
# browser after the row was flushed. Recomputed from merged values below so the
# persisted CSV is self-consistent instead of holding a stale zero.
PLAYBACK_DERIVED_FIELD_NAMES = [
    "latency_player_buffer_ms",
    "latency_accounted_ms",
    "latency_residual_ms",
    "playback_frame_drop_pct",
    "frame_delivery_pct",
]

PLAYBACK_GAUGE_KEYS = (
    "playback_bitrate_bps",
    "playback_ttff_ms",
    "playback_video_time_sec",
    "playback_buffer_sec",
    "e2e_latency_ms",
)

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
        incoming = {name: sample.get(name, 0) for name in PLAYBACK_FIELD_NAMES}
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


def _csv_number(value: object) -> str:
    number = _as_float(value)
    if number.is_integer():
        return str(int(number))
    return str(number)


def _playback_high_water(dest: dict, incoming: dict) -> dict:
    """Do not let a reconnect snapshot of zeros erase painted-glass counters."""
    merged = dict(dest)
    for name in PLAYBACK_COUNTER_KEYS:
        merged[name] = max(_as_float(dest.get(name)), _as_float(incoming.get(name)))
    for name in PLAYBACK_GAUGE_KEYS:
        value = _as_float(incoming.get(name))
        if value > 0:
            merged[name] = value
    return merged


def _recompute_derived(row: dict) -> None:
    """Refresh latency/frame columns that depend on merged playback values.

    Only rows that already carry the encoder-side columns are touched, so CSVs
    written before the latency decomposition existed pass through unchanged.
    """
    if "latency_accounted_ms" not in row:
        return
    from latency_budget import (
        LatencyBudget,
        frame_delivery_pct,
        playback_frame_drop_pct,
        player_buffer_latency_ms,
    )

    budget = LatencyBudget(
        encode_ms=_as_float(row.get("latency_encode_ms")),
        publish_ms=_as_float(row.get("latency_publish_ms")),
        network_ms=_as_float(row.get("latency_network_ms")),
        packager_ms=_as_float(row.get("latency_packager_ms")),
        player_buffer_ms=player_buffer_latency_ms(
            playback_buffer_sec=_as_float(row.get("playback_buffer_sec"))
        ),
        e2e_ms=_as_float(row.get("e2e_latency_ms")),
    )
    row["latency_player_buffer_ms"] = f"{budget.player_buffer_ms:.1f}"
    row["latency_accounted_ms"] = f"{budget.accounted_ms:.1f}"
    row["latency_residual_ms"] = f"{budget.residual_ms:.1f}"
    row["playback_frame_drop_pct"] = (
        f"{playback_frame_drop_pct(frames_rendered=_as_float(row.get('playback_frames_rendered')), frames_dropped=_as_float(row.get('playback_frames_dropped'))):.3f}"
    )
    row["frame_delivery_pct"] = (
        f"{frame_delivery_pct(encode_frames_total=_as_float(row.get('encode_frames_total')), playback_frames_rendered=_as_float(row.get('playback_frames_rendered'))):.2f}"
    )


def merge_playback_into_csv(
    csv_path: str,
    playback_samples: List[dict],
    *,
    csv_columns: List[str],
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
    updated: List[dict] = []
    # Merge nearest-at-or-before: playback ticks and CSV rows rarely share the
    # exact integer second (different loop phases), and requiring equality
    # left every playback_*/e2e column at 0. Forward-fill the latest playback
    # sample at-or-before each row's elapsed time instead.
    sorted_secs = sorted(by_sec)
    cursor = 0
    for index, row in enumerate(rows):
        elapsed = _row_elapsed_sec(rows, index)
        while cursor < len(sorted_secs) and sorted_secs[cursor] <= elapsed:
            last_values = {
                name: _csv_number(value)
                for name, value in _playback_high_water(
                    {name: _as_float(last_values[name]) for name in PLAYBACK_FIELD_NAMES},
                    by_sec[sorted_secs[cursor]],
                ).items()
            }
            cursor += 1
        merged = dict(row)
        merged.update(last_values)
        _recompute_derived(merged)
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


def compute_playback_averages(rows: List[dict]) -> Dict[str, float]:
    if not rows:
        return {}

    averages: Dict[str, float] = {}
    count = len(rows)

    for key in PLAYBACK_GAUGE_KEYS:
        if key not in rows[0]:
            continue
        values = [float(row.get(key, 0) or 0) for row in rows]
        if key == "e2e_latency_ms":
            stats = robust_e2e_stats(values)
            if stats:
                averages[key] = round(stats["avg"], 3)
                averages["e2e_latency_max_ms"] = round(stats["max"], 3)
            continue
        if any(value > 0 for value in values):
            averages[key] = round(sum(values) / count, 3)

    for key in PLAYBACK_COUNTER_KEYS:
        if key not in rows[0] and key not in rows[-1]:
            continue
        value = max(int(float(row.get(key, 0) or 0)) for row in rows)
        if value > 0:
            averages[key] = value

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
        "playback_frame_drop_pct",
        "frame_delivery_pct",
    ):
        if key not in rows[0]:
            continue
        values = [float(row.get(key, 0) or 0) for row in rows]
        live = [value for value in values if value > 0]
        if live:
            averages[key] = round(sum(live) / len(live), 3)

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
