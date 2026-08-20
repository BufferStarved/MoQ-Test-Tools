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
        updated.append(merged)

    fieldnames = list(csv_columns)
    for name in PLAYBACK_FIELD_NAMES:
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

    return averages


E2E_MIN_MS = 8.0
E2E_MAX_MS = 30_000.0


def robust_e2e_stats(values: List[float]) -> Optional[Dict[str, float]]:
    """Drop zeros / freeze runaways (values > 3× median), then average the rest."""
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
        "max": pool[-1],
    }


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
    extra["playback_sample_count"] = len(playback_samples)

    with open(summary_path, mode="w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
