"""Shared encode ladder + target-latency mapping for benchmark uploads.

Target latency is a glass-to-glass *budget* (ms), but it is **not** shared
across protocols. HLS/SRT/Zixi need a ~2s floor because packagers cut
segments on IDRs; MoQ has no playlist and must not inherit that floor.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, List, Sequence
from urllib.parse import parse_qs, quote, urlparse, urlunparse

MIN_TARGET_LATENCY_MS = 100
MAX_TARGET_LATENCY_MS = 10_000
# Lowest stable budget for segmented delivery (HLS / SRT / Zixi Fast HLS).
# SRT + Zixi Fast HLS starve below 2s; HLS chunks floor at 2s.
DEFAULT_TARGET_LATENCY_MS = 2000
# MoQ has no segments. Player hold + GOP use this — never the HLS 2s floor.
DEFAULT_MOQ_TARGET_LATENCY_MS = 400
# SRT (libsrt + Zixi Fast HLS / MediaMTX LL-HLS) needs receiver buffer headroom.
# Targets below 2s starve retransmits and make playback look "unusable".
SRT_MIN_TARGET_LATENCY_MS = 2000
# MediaMTX LL-HLS: cap caller latency so the first playlist is not delayed by
# multi-second SRT TSBPD, but keep enough for jitter (1s was too tight).
MEDIAMTX_SRT_MAX_CALLER_LATENCY_MS = 2000
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


def clamp_srt_target_latency_ms(value: int | float | None) -> int:
    """Floor SRT jobs at SRT_MIN_TARGET_LATENCY_MS for stable delivery."""
    return max(SRT_MIN_TARGET_LATENCY_MS, clamp_target_latency_ms(value))


def effective_srt_caller_latency_ms(
    target_latency_ms: int | float | None,
    *,
    mediamtx: bool = False,
) -> int:
    """Caller-side libsrt latency (ms) after SRT floor and MediaMTX cap."""
    ms = clamp_srt_target_latency_ms(target_latency_ms)
    if mediamtx:
        ms = min(ms, MEDIAMTX_SRT_MAX_CALLER_LATENCY_MS)
    return ms


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

    Floor — not round. Python's banker's ``round(2.5) == 2`` but JS
    ``Math.round(2.5) == 3``, which desynced encoder GOP from the player's
    liveSync at the common 5s target. Floor keeps 2s chunks through 5999ms,
    matching Zixi's default ``hls_chunk_time``.
    """
    ms = clamp_target_latency_ms(target_latency_ms)
    return max(
        HLS_SEGMENT_SEC_MIN,
        min(HLS_SEGMENT_SEC_MAX, ms // 2000 or HLS_SEGMENT_SEC_MIN),
    )


# Uniform IDR cadence for every non-MoQ delivery path (seconds). MediaMTX
# LL-HLS already pins 1s; Zixi was the lone outlier at 2s because the GOP was
# keyed to hls_chunk_time. A GOP does not have to equal the chunk — it only has
# to divide it, and 1s divides the 2s Fast HLS chunk exactly, so packaging is
# unchanged while the first decodable frame arrives a full second sooner.
DELIVERY_GOP_SEC = 1


def delivery_gop_frames(target_latency_ms: int, *, fps: int = ASSUMED_FPS) -> int:
    """IDR cadence for TS/HLS delivery: 1s, or segment/2 for long segments.

    HTTP-TS (Zixi ``http_ts_auto_out``) is a continuous transport stream —
    mpegts.js starts decoding at the first IDR it sees, so the GOP *is* the
    join floor and the chunk duration is irrelevant to it. RTMP→Zixi carried
    a 2s GOP purely because ``gop_frames_for_latency`` keys off
    ``hls_segment_sec``, which put a hard ~2s floor under every measured TTFF
    (23s observed on Linode 2026-08-22, of which 2s was this floor and the
    rest was probe/attach churn).

    Keeping the GOP an exact divisor of the segment preserves Fast HLS chunk
    boundaries (2s chunk = 2 GOPs), so nothing downstream of the packager
    changes. It also gives every protocol the same 1s keyframe cadence —
    MediaMTX LL-HLS, MoQ, and now Zixi — which is what makes cross-protocol
    TTFF and glass-delay numbers comparable instead of GOP-confounded.
    """
    segment = float(hls_segment_sec(clamp_target_latency_ms(target_latency_ms)))
    seconds = max(float(DELIVERY_GOP_SEC), segment / 2.0)
    return max(1, int(round(seconds * fps)))


def gop_frames_for_latency(target_latency_ms: int, *, fps: int = ASSUMED_FPS) -> int:
    """Keyframe interval == intended HLS segment duration, NOT the latency budget.

    HLS packagers (Zixi Fast HLS, MediaMTX LL-HLS) can only cut segments on
    IDR frames, so the effective segment duration is max(configured segment,
    GOP). The old mapping sized the GOP to the *whole* latency budget, which
    silently stretched every segment to match: a 4s target produced 4s GOPs
    -> 4s chunks -> a 2-chunk player buffer of 8s -> ~16.7s real glass-to-
    glass (measured live 2026-07-21, RTMP->Zixi leg pinned at e2e=16.7s the
    entire run). Keying the GOP to hls_segment_sec keeps chunks at the size
    the rest of the pipeline is tuned for (player live sync ~= 2 x segment
    ~= the latency target).
    """
    ms = clamp_target_latency_ms(target_latency_ms)
    seconds = hls_segment_sec(ms)
    return max(fps, min(150, int(round(seconds * fps))))


def srt_latency_us(target_latency_ms: int) -> int:
    """libsrt / Zixi SRT latency is specified in microseconds."""
    return clamp_target_latency_ms(target_latency_ms) * 1000


# MoQ GOP bounds (seconds). Solo/file encode, and brokered MoQ children when
# dest_count >= 2 (re-encode, not copy). The shared webcam broker master stays
# at 1s (MASTER_GOP_FRAMES) — do not drop it to 0.5s (24fps / 0.8×).
# Floor 0.25s is 8 frames @ 30fps.
MOQ_GOP_SEC_MIN = 0.25
MOQ_GOP_SEC_MAX = 1.0
# Shared broker master IDR cadence. Must match webcam_broker.MASTER_GOP_FRAMES.
# Only reported when dest_count < 2 still copies that bitstream.
BROKER_GOP_MS = 1000.0
# MediaMTX LL-HLS part duration — the HLS object, not a 1s CMAF group.
LL_HLS_PART_MS = 200.0


def moq_gop_frames_for_latency(target_latency_ms: int, *, fps: int = ASSUMED_FPS) -> int:
    """MoQ keyframe interval: ~half the latency budget, NOT the whole budget.

    gop_frames_for_latency() sizes the GOP to the full latency target because
    Zixi HLS segments must land on IDR boundaries. But openmoq maps one CMAF
    fragment (= one GOP with -movflags frag_keyframe) to one MoQ group/object,
    and the player joins on NextGroupStart with no catch-up (no LOC
    CaptureTimestamps). So for MoQ the GOP *is* the latency floor twice over:
    a fragment ships only after the whole GOP is encoded (+1 GOP), and a
    subscriber waits up to a GOP for the next join point (+0..1 GOP) — an
    offset that then persists for the entire session. That wait is
    ``latency_segmentation_ms`` (CMAF group), not ingest RTT. GOP = target/2
    keeps worst-case join (2 × GOP) at or under the target; the floor is
    0.25s for solo/file and dest_count >= 2 re-encode (copy stays 1s).
    """
    ms = clamp_target_latency_ms(target_latency_ms)
    seconds = min(MOQ_GOP_SEC_MAX, max(MOQ_GOP_SEC_MIN, ms / 2000.0))
    return max(1, int(round(seconds * fps)))


def moq_group_duration_ms(
    target_latency_ms: int,
    *,
    brokered: bool = False,
    dest_count: int = 1,
    fps: int = ASSUMED_FPS,
) -> float:
    """Closed-group duration the NextGroupStart subscriber must wait.

    dest_count < 2 on a brokered hop still copies the 1s master — do not
    report the solo 0.25s GOP for that bitstream. dest_count >= 2 re-encodes
    at ``moq_gop_frames_for_latency``. File/solo use that GOP too.
    This is object cadence, not ingest RTT.
    """
    if brokered and dest_count < 2:
        return float(BROKER_GOP_MS)
    frames = moq_gop_frames_for_latency(target_latency_ms, fps=fps)
    return round((frames / float(fps)) * 1000.0, 1)


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


def moq_player_target_latency_ms(target_latency_ms: int | float | None) -> int:
    """MoQ player hold budget. Does not inherit the HLS/SRT 2s segment floor."""
    ms = clamp_target_latency_ms(
        target_latency_ms if target_latency_ms is not None else DEFAULT_MOQ_TARGET_LATENCY_MS
    )
    if ms >= SRT_MIN_TARGET_LATENCY_MS:
        return DEFAULT_MOQ_TARGET_LATENCY_MS
    return ms


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


def utc_burnin_drawtext(
    *,
    wallclock_pts: bool = False,
    epoch_sec: int | None = None,
) -> str:
    """ffmpeg drawtext that stamps a documented clock — never epoch+PTS mashed.

    Testers compare this overlay to a wall clock or to "how far into the
    encode is this frame". ``%{pts:gmtime:<epoch>}`` on zero-based PTS is
    encode-start Unix + media time, which reads as a UTC date and is *not*
    the media timeline. Do not use that mash.

    - Live UDP/SRT/RTSP (``-use_wallclock_as_timestamps``): PTS is already
      Unix time → ``capture time %{pts:gmtime}Z`` is capture wall-clock.
    - File / device-webcam (zero-based PTS): ``encode time %{pts:hms}`` is the
      media timeline from encode start (HH:MM:SS.mmm).

    ``epoch_sec`` is accepted for call-site compat and ignored — the overlay
    is no longer epoch-anchored.
    """
    # Filtergraph escaping: pass as one argv element (no shell). Colons inside
    # %{pts:…} must be backslash-escaped for the filter parser.
    del epoch_sec  # documented: not used; keep the keyword for callers
    if wallclock_pts:
        text = "capture time %{pts\\:gmtime}Z"
    else:
        text = "encode time %{pts\\:hms}"
    return (
        "drawtext=fontsize=28:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8:"
        f"x=24:y=24:text='{text}'"
    )


# Back-compat alias for callers/tests that import a constant. Prefer
# utc_burnin_drawtext() so epoch is captured at encode-command build time.
UTC_BURNIN_DRAWTEXT = utc_burnin_drawtext()


def build_video_encode_args(
    ladder_id: str | None,
    target_latency_ms: int | None,
    *,
    gop_frames: int | None = None,
    wallclock_pts: bool = False,
    burnin_epoch_sec: int | None = None,
    vbv_stability: bool = False,
    preset: str | None = None,
    output_cfr: bool = True,
    rebase_pts: bool = False,
) -> List[str]:
    ladder = resolve_encode_ladder(ladder_id)
    latency_ms = clamp_target_latency_ms(target_latency_ms)
    gop = gop_frames if gop_frames and gop_frames > 0 else gop_frames_for_latency(latency_ms)
    # VBV buffer: ~1–2× bitrate over the latency window (smaller = snappier, less stable).
    # SRT paths use a wider window (3.5×) to reduce TS pacing underruns under loss.
    window_sec = max(0.25, latency_ms / 1000.0)
    vbv_mult = 3.5 if vbv_stability else 2.0
    bufsize_kb = max(ladder.maxrate_kbps, int(round(ladder.maxrate_kbps * window_sec * vbv_mult)))
    burnin = utc_burnin_drawtext(
        wallclock_pts=wallclock_pts,
        epoch_sec=burnin_epoch_sec,
    )
    # Scale + PTS-anchored UTC burn-in — do not insert an fps= filter here.
    # Stacking fps=30 with -re pacing + openmoq --paced produced "half-speed"
    # looking playback even when HTMLVideoElement.currentTime advanced at 1×.
    # Device webcam VFR is normalized here via -fps_mode cfr below.
    vf = f"scale=-2:{ladder.height},{burnin}"
    if rebase_pts:
        # AVFoundation PTS are wallclock (~1e5 s, 1000k tbn). File MoQ is
        # zero-based. Rebase so CMAF tfdt/MSE match the file path.
        vf = f"setpts=PTS-STARTPTS,{vf}"
    args: List[str] = [
        "-vf",
        vf,
    ]
    if output_cfr:
        # Do not stack this on a pinned 720p30 AVFoundation capture:
        # 1000k tbr + -r 30 made speed oscillate 0.8↔1.3 (job 973f0c1b).
        args.extend(["-fps_mode", "cfr", "-r", str(ASSUMED_FPS)])
    args.extend([
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "main",
        "-level:v",
        "4.0",
        "-preset",
        preset or "veryfast",
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
    ])
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
    moq_ms = moq_player_target_latency_ms(latency_ms)
    return {
        "encode_ladder": ladder.id,
        "encode_ladder_label": ladder.label,
        "height": ladder.height,
        "bitrate_kbps": ladder.bitrate_kbps,
        "maxrate_kbps": ladder.maxrate_kbps,
        "minrate_kbps": ladder.minrate_kbps,
        "target_latency_ms": latency_ms,
        "gop_frames": gop_frames_for_latency(latency_ms),
        "delivery_gop_frames": delivery_gop_frames(latency_ms),
        "srt_latency_us": srt_latency_us(latency_ms),
        "hls_segment_sec": hls_segment_sec(latency_ms),
        "hls_live_sync_duration_sec": hls_live_sync_duration_sec(latency_ms),
        "hls_live_sync_count": hls_live_sync_count(latency_ms),
        "moq_target_latency_ms": moq_ms,
        "moq_gop_frames": moq_gop_frames_for_latency(moq_ms),
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
    "BROKER_GOP_MS",
    "DEFAULT_ENCODE_LADDER_ID",
    "DEFAULT_MOQ_TARGET_LATENCY_MS",
    "DEFAULT_TARGET_LATENCY_MS",
    "DELIVERY_GOP_SEC",
    "ENCODE_LADDERS",
    "EncodeLadder",
    "MAX_TARGET_LATENCY_MS",
    "MIN_TARGET_LATENCY_MS",
    "SRT_MIN_TARGET_LATENCY_MS",
    "MEDIAMTX_SRT_MAX_CALLER_LATENCY_MS",
    "UTC_BURNIN_DRAWTEXT",
    "build_video_encode_args",
    "clamp_srt_target_latency_ms",
    "clamp_target_latency_ms",
    "delivery_gop_frames",
    "effective_srt_caller_latency_ms",
    "encode_profile_summary",
    "ensure_known_ladder",
    "gop_frames_for_latency",
    "moq_gop_frames_for_latency",
    "moq_group_duration_ms",
    "hls_live_sync_count",
    "hls_live_sync_duration_sec",
    "hls_segment_sec",
    "HLS_SEGMENT_SEC_MIN",
    "LL_HLS_PART_MS",
    "list_encode_ladders",
    "moq_player_target_latency_ms",
    "resolve_encode_ladder",
    "srt_latency_us",
    "utc_burnin_drawtext",
    "with_srt_latency",
]
