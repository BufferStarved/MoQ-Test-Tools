"""Shared encode ladder + target-latency mapping for benchmark uploads.

Target latency is treated as a glass-to-glass *budget* (ms). It scales:
  - encoder GOP / bufsize / zerolatency tune
  - SRT caller `latency` (µs) and Zixi SRT input latency
  - MoQ player `targetLatencyMs`
  - HLS segment duration (Zixi hls_chunk_time, min 2s) and player live buffer
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence
from urllib.parse import parse_qs, quote, urlparse, urlunparse

MIN_TARGET_LATENCY_MS = 100
MAX_TARGET_LATENCY_MS = 10_000
DEFAULT_TARGET_LATENCY_MS = 800
DEFAULT_ENCODE_LADDER_ID = "720p"
ASSUMED_FPS = 30

# Zixi HLS: 1s chunks underrun constantly. Floor at 2s; grow when latency allows.
HLS_SEGMENT_SEC_MIN = 2
HLS_SEGMENT_SEC_MAX = 6
HLS_LIVE_SYNC_SEGMENTS_DEFAULT = 2  # standard buffer = 2 × segment
HLS_LIVE_SYNC_DURATION_SEC_MIN = 1  # may tighten toward low latency targets


@dataclass(frozen=True)
class EncodeLadder:
    id: str
    label: str
    height: int
    bitrate_kbps: int
    maxrate_kbps: int
    minrate_kbps: int


ENCODE_LADDERS: Dict[str, EncodeLadder] = {
    "1080p": EncodeLadder(
        id="1080p",
        label="1080p · 4500–6000 kbps",
        height=1080,
        bitrate_kbps=5250,
        maxrate_kbps=6000,
        minrate_kbps=4500,
    ),
    "720p": EncodeLadder(
        id="720p",
        label="720p · 2500–3500 kbps",
        height=720,
        bitrate_kbps=3000,
        maxrate_kbps=3500,
        minrate_kbps=2500,
    ),
    "540p": EncodeLadder(
        id="540p",
        label="540p · 1200–1800 kbps",
        height=540,
        bitrate_kbps=1500,
        maxrate_kbps=1800,
        minrate_kbps=1200,
    ),
    "360p": EncodeLadder(
        id="360p",
        label="360p · 600–800 kbps",
        height=360,
        bitrate_kbps=700,
        maxrate_kbps=800,
        minrate_kbps=600,
    ),
}


def clamp_target_latency_ms(value: int | float | None) -> int:
    try:
        ms = int(value) if value is not None else DEFAULT_TARGET_LATENCY_MS
    except (TypeError, ValueError):
        ms = DEFAULT_TARGET_LATENCY_MS
    return max(MIN_TARGET_LATENCY_MS, min(MAX_TARGET_LATENCY_MS, ms))


def resolve_encode_ladder(ladder_id: str | None) -> EncodeLadder:
    key = (ladder_id or DEFAULT_ENCODE_LADDER_ID).strip().lower()
    return ENCODE_LADDERS.get(key, ENCODE_LADDERS[DEFAULT_ENCODE_LADDER_ID])


def list_encode_ladders() -> List[dict]:
    return [
        {
            "id": ladder.id,
            "label": ladder.label,
            "height": ladder.height,
            "bitrate_kbps": ladder.bitrate_kbps,
            "maxrate_kbps": ladder.maxrate_kbps,
            "minrate_kbps": ladder.minrate_kbps,
        }
        for ladder in ENCODE_LADDERS.values()
    ]


def hls_segment_sec(target_latency_ms: int) -> int:
    """Recommended Zixi HLS chunk duration (seconds).

    Minimum 2s (1s packs stutter). Grows when the latency budget allows a
    ~2-segment player buffer at the target (segment ≈ target/2).
    """
    ms = clamp_target_latency_ms(target_latency_ms)
    return max(
        HLS_SEGMENT_SEC_MIN,
        min(HLS_SEGMENT_SEC_MAX, int(round(ms / 2000.0)) or HLS_SEGMENT_SEC_MIN),
    )


def gop_frames_for_latency(target_latency_ms: int, *, fps: int = ASSUMED_FPS) -> int:
    """Keyframe interval ≈ one GOP per latency budget (clamped for stability).

    Floor at HLS_SEGMENT_SEC_MIN seconds so Zixi HLS chunks land on IDR
    boundaries instead of cutting ~1s packs when the latency target is low.
    """
    ms = clamp_target_latency_ms(target_latency_ms)
    frames = int(round((ms / 1000.0) * fps))
    min_frames = HLS_SEGMENT_SEC_MIN * fps
    return max(min_frames, min(150, frames))


def srt_latency_us(target_latency_ms: int) -> int:
    """libsrt / Zixi SRT latency is specified in microseconds."""
    return clamp_target_latency_ms(target_latency_ms) * 1000


# MoQ GOP bounds (seconds). Floor keeps x264 overhead sane; ceiling keeps the
# group cadence short enough that join-offset + fragment accumulation stay
# inside the latency budget.
MOQ_GOP_SEC_MIN = 0.5
MOQ_GOP_SEC_MAX = 2.0


def moq_gop_frames_for_latency(target_latency_ms: int, *, fps: int = ASSUMED_FPS) -> int:
    """MoQ keyframe interval: ~half the latency budget, NOT the whole budget.

    gop_frames_for_latency() sizes the GOP to the full latency target because
    Zixi HLS segments must land on IDR boundaries. But openmoq maps one CMAF
    fragment (= one GOP with -movflags frag_keyframe) to one MoQ group/object,
    and the player joins on NextGroupStart with no catch-up (no LOC
    CaptureTimestamps). So for MoQ the GOP *is* the latency floor twice over:
    a fragment ships only after the whole GOP is encoded (+1 GOP), and a
    subscriber waits up to a GOP for the next join point (+0..1 GOP) — an
    offset that then persists for the entire session. With a 4s target the old
    shared mapping produced 4s GOPs -> ~1.9MB objects every 4-5s and a real
    glass-to-glass of 9-11s (relay logs, 2026-07-20). GOP = target/2 keeps
    worst-case join latency (2 x GOP) at or under the target.
    """
    ms = clamp_target_latency_ms(target_latency_ms)
    seconds = min(MOQ_GOP_SEC_MAX, max(MOQ_GOP_SEC_MIN, ms / 2000.0))
    return max(1, int(round(seconds * fps)))


def hls_live_sync_duration_sec(target_latency_ms: int) -> float:
    """hls.js liveSyncDuration (seconds of intentional live buffer).

    Standard: 2 × segment (4s at the 2s minimum). May tighten toward the
    latency target, but never below one segment (sub-segment sync breaks
    non-LL Zixi HLS).
    """
    ms = clamp_target_latency_ms(target_latency_ms)
    segment = float(hls_segment_sec(ms))
    default_buf = float(segment * HLS_LIVE_SYNC_SEGMENTS_DEFAULT)
    target_sec = ms / 1000.0
    desired = min(default_buf, target_sec if target_sec > 0 else default_buf)
    return max(segment, min(default_buf, desired))


def hls_live_sync_count(target_latency_ms: int) -> int:
    """hls.js liveSyncDurationCount fallback derived from duration ÷ segment."""
    segment = hls_segment_sec(target_latency_ms)
    duration = hls_live_sync_duration_sec(target_latency_ms)
    return max(1, min(5, int(round(duration / segment)) or 1))


def moq_player_target_latency_ms(target_latency_ms: int) -> int:
    return clamp_target_latency_ms(target_latency_ms)


def with_srt_latency(url: str, target_latency_ms: int) -> str:
    """Set or replace the SRT `latency` query param (microseconds)."""
    parsed = urlparse((url or "").strip())
    if parsed.scheme != "srt":
        return url
    query = parse_qs(parsed.query, keep_blank_values=True)
    query["latency"] = [str(srt_latency_us(target_latency_ms))]
    # Keep streamid punctuation (: # ! = ,) intact — MediaMTX expects
    # ``publish:benchmark``, not ``publish%3Abenchmark``.
    flat_query = "&".join(
        f"{key}={quote(values[-1], safe=':#!/@=,')}" for key, values in query.items() if values
    )
    return urlunparse(
        (parsed.scheme, parsed.netloc, parsed.path, parsed.params, flat_query, parsed.fragment)
    )


def build_video_encode_args(
    ladder_id: str | None,
    target_latency_ms: int | None,
    *,
    gop_frames: int | None = None,
) -> List[str]:
    ladder = resolve_encode_ladder(ladder_id)
    latency_ms = clamp_target_latency_ms(target_latency_ms)
    gop = gop_frames if gop_frames and gop_frames > 0 else gop_frames_for_latency(latency_ms)
    # VBV buffer: ~1–2× bitrate over the latency window (smaller = snappier, less stable).
    window_sec = max(0.25, latency_ms / 1000.0)
    bufsize_kb = max(ladder.maxrate_kbps, int(round(ladder.maxrate_kbps * window_sec * 2)))
    # Scale only — do not insert an fps= filter here. Stacking fps=30 with -re
    # pacing + openmoq --paced produced "half-speed" looking playback even when
    # HTMLVideoElement.currentTime advanced at 1×. Webcam/UDP VFR is normalized
    # in the live bridge (web/api/live_webcam.py) instead.
    args: List[str] = [
        "-vf",
        f"scale=-2:{ladder.height}",
        "-fps_mode",
        "cfr",
        "-r",
        str(ASSUMED_FPS),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "main",
        "-level:v",
        "4.0",
        "-preset",
        "veryfast",
        "-g",
        str(gop),
        "-keyint_min",
        str(gop),
        "-sc_threshold",
        "0",
        "-bf",
        "0",
        "-b:v",
        f"{ladder.bitrate_kbps}k",
        "-maxrate",
        f"{ladder.maxrate_kbps}k",
        "-minrate",
        f"{ladder.minrate_kbps}k",
        "-bufsize",
        f"{bufsize_kb}k",
        "-x264-params",
        "repeat-headers=1",
    ]
    if latency_ms <= 500:
        # Insert tune after preset for ultra-low latency budgets.
        preset_idx = args.index("-preset")
        args.insert(preset_idx + 2, "-tune")
        args.insert(preset_idx + 3, "zerolatency")
    return args


def encode_profile_summary(
    ladder_id: str | None,
    target_latency_ms: int | None,
) -> dict:
    ladder = resolve_encode_ladder(ladder_id)
    latency_ms = clamp_target_latency_ms(target_latency_ms)
    return {
        "encode_ladder": ladder.id,
        "encode_ladder_label": ladder.label,
        "height": ladder.height,
        "bitrate_kbps": ladder.bitrate_kbps,
        "maxrate_kbps": ladder.maxrate_kbps,
        "minrate_kbps": ladder.minrate_kbps,
        "target_latency_ms": latency_ms,
        "gop_frames": gop_frames_for_latency(latency_ms),
        "srt_latency_us": srt_latency_us(latency_ms),
        "hls_segment_sec": hls_segment_sec(latency_ms),
        "hls_live_sync_duration_sec": hls_live_sync_duration_sec(latency_ms),
        "hls_live_sync_count": hls_live_sync_count(latency_ms),
        "moq_target_latency_ms": moq_player_target_latency_ms(latency_ms),
    }


def ensure_known_ladder(ladder_id: str) -> str:
    if ladder_id not in ENCODE_LADDERS:
        raise ValueError(
            f"Unknown encode_ladder '{ladder_id}'. "
            f"Expected one of: {', '.join(ENCODE_LADDERS)}"
        )
    return ladder_id


# Re-export for callers that already import audio args from moq_publish.
__all__ = [
    "ASSUMED_FPS",
    "DEFAULT_ENCODE_LADDER_ID",
    "DEFAULT_TARGET_LATENCY_MS",
    "ENCODE_LADDERS",
    "EncodeLadder",
    "MAX_TARGET_LATENCY_MS",
    "MIN_TARGET_LATENCY_MS",
    "build_video_encode_args",
    "clamp_target_latency_ms",
    "encode_profile_summary",
    "ensure_known_ladder",
    "gop_frames_for_latency",
    "moq_gop_frames_for_latency",
    "hls_live_sync_count",
    "hls_live_sync_duration_sec",
    "hls_segment_sec",
    "HLS_SEGMENT_SEC_MIN",
    "list_encode_ladders",
    "moq_player_target_latency_ms",
    "resolve_encode_ladder",
    "srt_latency_us",
    "with_srt_latency",
]
