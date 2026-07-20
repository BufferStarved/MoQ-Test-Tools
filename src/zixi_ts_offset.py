"""Monotonic ffmpeg -output_ts_offset for Zixi Fast HLS across file republishes.

Zixi reuses the Fast HLS packager across SRT reconnects. Each file publish that
rewinds PTS to ~0 lands behind the packager high-water mark, so the playlist
stalls. Matt (Zixi): advance each publish's output timeline above the previous
one with ``-output_ts_offset``.

State is keyed by Zixi stream id and persists across jobs on the encode host.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Dict, Tuple

logger = logging.getLogger("MoQ-SRT-Bench")

# Stay under ~33-bit MPEG-TS wrap (~95_000 s) per Zixi guidance.
_MAX_OFFSET_SEC = 95_000
_DEFAULT_STEP_FLOOR_SEC = 300
# If nobody has published to this Zixi stream id in this long, the packager has
# almost certainly gone idle/reinitialized on its own — restart our counter at 0
# instead of accumulating forever. A live site reused across many benchmark runs
# (same default "SRT Test" stream id) would otherwise walk the offset into the
# hours within a single day, which surfaces to viewers as an absolute (not
# session-relative) HLS playhead showing "hours" of media while only the last
# few seconds are actually buffered/playable.
_DEFAULT_STALE_RESET_SEC = 1800
_LOCK = threading.Lock()

_DEFAULT_STATE_DIRS = (
    "/var/lib/moq-web",
    "/opt/moq-test-tools/results",
    "/tmp/moq-web-zixi-ts-offset",
)


def ts_offset_enabled() -> bool:
    flag = os.environ.get("ZIXI_OUTPUT_TS_OFFSET", "1").strip().lower()
    return flag not in {"0", "false", "no", "off"}


def _state_path() -> Path:
    override = os.environ.get("ZIXI_TS_OFFSET_STATE", "").strip()
    if override:
        return Path(override)
    for directory in _DEFAULT_STATE_DIRS:
        path = Path(directory)
        try:
            path.mkdir(parents=True, exist_ok=True)
            probe = path / ".zixi_ts_offset_write_probe"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return path / "zixi_ts_offset.json"
        except OSError:
            continue
    return Path("/tmp/moq-web-zixi-ts-offset/zixi_ts_offset.json")


def stale_reset_seconds() -> int:
    floor = int(
        os.environ.get("ZIXI_TS_OFFSET_STALE_RESET_SEC", str(_DEFAULT_STALE_RESET_SEC))
    )
    return max(0, floor)


def _load(path: Path) -> Dict[str, Tuple[int, float]]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Tuple[int, float]] = {}
    for key, value in raw.items():
        try:
            if isinstance(value, dict):
                out[str(key)] = (int(value.get("index", 0)), float(value.get("updated_at", 0.0)))
            else:
                # Legacy format: bare integer index, no timestamp.
                out[str(key)] = (int(value), 0.0)
        except (TypeError, ValueError):
            continue
    return out


def _save(path: Path, data: Dict[str, Tuple[int, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    serializable = {
        key: {"index": index, "updated_at": updated_at} for key, (index, updated_at) in data.items()
    }
    tmp.write_text(json.dumps(serializable, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def step_seconds(duration_sec: int) -> int:
    floor = int(os.environ.get("ZIXI_TS_OFFSET_STEP_FLOOR", str(_DEFAULT_STEP_FLOOR_SEC)))
    floor = max(1, floor)
    return max(int(duration_sec or 0), floor)


def allocate_output_ts_offset(stream_id: str, *, duration_sec: int) -> float:
    """Return the next offset (seconds) for this stream and persist the counter.

    Returns 0 when disabled or stream_id is empty. Auto-resets to 0 when the
    stream id has been idle longer than ``stale_reset_seconds()`` — a long gap
    means the Zixi Fast HLS packager has almost certainly gone idle on its own,
    so there is no continuity to preserve and no reason to keep accumulating.
    """
    if not ts_offset_enabled():
        return 0.0
    key = (stream_id or "").strip()
    if not key:
        return 0.0

    step = step_seconds(duration_sec)
    stale_after = stale_reset_seconds()
    now = time.time()
    path = _state_path()
    with _LOCK:
        data = _load(path)
        index, updated_at = data.get(key, (0, 0.0))
        if stale_after and updated_at and (now - updated_at) > stale_after:
            logger.info(
                "Zixi output_ts_offset for '%s' idle %.0fs > %ss threshold; resetting to 0.",
                key,
                now - updated_at,
                stale_after,
            )
            index = 0
        offset = index * step
        if offset >= _MAX_OFFSET_SEC:
            logger.warning(
                "Zixi TS offset for '%s' hit %s s wrap ceiling; resetting counter.",
                key,
                _MAX_OFFSET_SEC,
            )
            index = 0
            offset = 0
        data[key] = (index + 1, now)
        try:
            _save(path, data)
        except OSError:
            logger.exception("Failed to persist Zixi TS offset state at %s", path)
        logger.info(
            "Zixi output_ts_offset for '%s': %.0fs (step=%ss, next_index=%s)",
            key,
            offset,
            step,
            index + 1,
        )
        return float(offset)


def reset_output_ts_offset(stream_id: str) -> None:
    """Clear the counter after an intentional Zixi input recreate (fresh packager)."""
    key = (stream_id or "").strip()
    if not key:
        return
    path = _state_path()
    with _LOCK:
        data = _load(path)
        if key not in data:
            return
        data.pop(key, None)
        try:
            _save(path, data)
        except OSError:
            logger.exception("Failed to reset Zixi TS offset state at %s", path)
            return
        logger.info("Reset Zixi output_ts_offset counter for '%s'", key)


def ffmpeg_output_ts_offset_args(offset_sec: float) -> list[str]:
    if offset_sec is None or float(offset_sec) <= 0:
        return []
    # ffmpeg accepts seconds (float) for -output_ts_offset.
    value = float(offset_sec)
    if value == int(value):
        text = str(int(value))
    else:
        text = f"{value:.3f}"
    return ["-output_ts_offset", text]
