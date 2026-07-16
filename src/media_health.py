"""Merge Media Health counters (CMAF integrity) into benchmark CSV/summary."""
from __future__ import annotations

import csv
import json
import logging
from typing import Dict, List, Optional

from cmaf_integrity import CmafIntegrityReport, analyze_cmaf_file

logger = logging.getLogger("MoQ-SRT-Bench")

MEDIA_HEALTH_CMAF_FIELDS = [
    "cmaf_fragment_count",
    "cmaf_seq_gap_count",
    "cmaf_tfdt_gap_count",
    "cmaf_tfdt_gap_ms",
    "cmaf_tfdt_overlap_count",
    "cmaf_parse_errors",
]

MEDIA_HEALTH_DEFAULTS = {name: "0" for name in MEDIA_HEALTH_CMAF_FIELDS}


def analyze_media_health_file(path: str) -> CmafIntegrityReport:
    return analyze_cmaf_file(path)


def merge_cmaf_into_csv(
    csv_path: str,
    report: CmafIntegrityReport,
    *,
    csv_columns: List[str],
) -> List[dict]:
    """Fill CMAF media-health columns by elapsed_sec (forward-filled cumulative)."""
    if not report.events and report.fragment_count == 0:
        return []

    with open(csv_path, mode="r", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
    if not rows:
        return []

    by_sec = report.cumulative_by_elapsed_sec()
    last = dict(MEDIA_HEALTH_DEFAULTS)
    # If we have totals but no per-sec map, put finals on the last row only.
    if not by_sec and report.fragment_count > 0:
        by_sec = {
            max(0, len(rows) - 1): {
                "cmaf_fragment_count": report.fragment_count,
                "cmaf_seq_gap_count": report.seq_gap_count,
                "cmaf_tfdt_gap_count": report.tfdt_gap_count,
                "cmaf_tfdt_gap_ms": round(report.tfdt_gap_ms_total, 3),
                "cmaf_tfdt_overlap_count": report.tfdt_overlap_count,
                "cmaf_parse_errors": report.parse_errors,
            }
        }

    updated: List[dict] = []
    for index, row in enumerate(rows):
        try:
            first_ts = float(rows[0].get("timestamp", 0) or 0)
            row_ts = float(row.get("timestamp", 0) or 0)
            elapsed = max(0, int(round(row_ts - first_ts))) if first_ts and row_ts else index
        except (TypeError, ValueError):
            elapsed = index
        if elapsed in by_sec:
            for name in MEDIA_HEALTH_CMAF_FIELDS:
                last[name] = str(by_sec[elapsed].get(name, last[name]))
        merged = dict(row)
        merged.update(last)
        updated.append(merged)

    # Ensure final totals land on the last sample.
    if updated:
        finals = {
            "cmaf_fragment_count": report.fragment_count,
            "cmaf_seq_gap_count": report.seq_gap_count,
            "cmaf_tfdt_gap_count": report.tfdt_gap_count,
            "cmaf_tfdt_gap_ms": round(report.tfdt_gap_ms_total, 3),
            "cmaf_tfdt_overlap_count": report.tfdt_overlap_count,
            "cmaf_parse_errors": report.parse_errors,
        }
        for name, value in finals.items():
            updated[-1][name] = str(value)

    fieldnames = list(csv_columns)
    for name in MEDIA_HEALTH_CMAF_FIELDS:
        if name not in fieldnames:
            fieldnames.append(name)

    with open(csv_path, mode="w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(updated)
    return updated


def patch_summary_with_media_health(
    summary_path: str,
    report: CmafIntegrityReport,
    *,
    computed_on: str = "local",
) -> None:
    if not summary_path:
        return
    try:
        with open(summary_path, mode="r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Could not read summary for media health: %s", exc)
        return

    csv_path = payload.get("csv_path", "")
    if csv_path:
        from metrics import CSV_COLUMNS

        merge_cmaf_into_csv(csv_path, report, csv_columns=CSV_COLUMNS)

    media_health = {
        "status": "failed" if report.error and report.fragment_count == 0 else "completed",
        "computed_on": computed_on,
        "kind": "cmaf",
        **{k: v for k, v in report.as_summary_dict().items() if k != "error"},
    }
    if report.error:
        media_health["error"] = report.error

    payload.setdefault("quality", {})["media_health"] = media_health
    averages = payload.setdefault("averages", {})
    averages["cmaf_fragment_count"] = report.fragment_count
    averages["cmaf_seq_gap_count"] = report.seq_gap_count
    averages["cmaf_tfdt_gap_count"] = report.tfdt_gap_count
    averages["cmaf_tfdt_gap_ms"] = round(report.tfdt_gap_ms_total, 3)
    averages["cmaf_tfdt_overlap_count"] = report.tfdt_overlap_count
    averages["cmaf_parse_errors"] = report.parse_errors

    payload.setdefault("extra", {})["media_health_enabled"] = True
    payload["extra"]["media_health_computed_on"] = computed_on

    with open(summary_path, mode="w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
