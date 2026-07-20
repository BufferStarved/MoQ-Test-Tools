export const MIN_TARGET_LATENCY_MS = 100;
export const MAX_TARGET_LATENCY_MS = 10_000;
export const DEFAULT_TARGET_LATENCY_MS = 800;
export const DEFAULT_ENCODE_LADDER_ID = "720p";
export const ASSUMED_FPS = 30;

/** Mirrors src/encode_profile.py — Zixi HLS chunk floor (1s packs stutter). */
export const HLS_SEGMENT_SEC_MIN = 2;
export const HLS_SEGMENT_SEC_MAX = 6;
export const HLS_LIVE_SYNC_SEGMENTS_DEFAULT = 2;
export const HLS_LIVE_SYNC_DURATION_SEC_MIN = 1;

export interface EncodeLadderOption {
  id: string;
  label: string;
  height: number;
  bitrate_kbps: number;
  maxrate_kbps: number;
  minrate_kbps: number;
}

/** Mirrors src/encode_profile.py — kept local so the UI works before API bootstrap. */
export const ENCODE_LADDER_OPTIONS: EncodeLadderOption[] = [
  {
    id: "1080p",
    label: "1080p · 4500–6000 kbps",
    height: 1080,
    bitrate_kbps: 5250,
    maxrate_kbps: 6000,
    minrate_kbps: 4500,
  },
  {
    id: "720p",
    label: "720p · 2500–3500 kbps",
    height: 720,
    bitrate_kbps: 3000,
    maxrate_kbps: 3500,
    minrate_kbps: 2500,
  },
  {
    id: "540p",
    label: "540p · 1200–1800 kbps",
    height: 540,
    bitrate_kbps: 1500,
    maxrate_kbps: 1800,
    minrate_kbps: 1200,
  },
  {
    id: "360p",
    label: "360p · 600–800 kbps",
    height: 360,
    bitrate_kbps: 700,
    maxrate_kbps: 800,
    minrate_kbps: 600,
  },
];

export function clampTargetLatencyMs(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TARGET_LATENCY_MS;
  }
  return Math.max(MIN_TARGET_LATENCY_MS, Math.min(MAX_TARGET_LATENCY_MS, Math.round(value)));
}

export function resolveEncodeLadder(ladderId: string | null | undefined): EncodeLadderOption {
  const key = (ladderId || DEFAULT_ENCODE_LADDER_ID).trim().toLowerCase();
  return ENCODE_LADDER_OPTIONS.find((ladder) => ladder.id === key) ?? ENCODE_LADDER_OPTIONS[1];
}

/** Keyframe interval ≈ one GOP per latency budget (floor at 2s for HLS IDR alignment). */
export function gopFramesForLatency(targetLatencyMs: number, fps = ASSUMED_FPS): number {
  const ms = clampTargetLatencyMs(targetLatencyMs);
  const frames = Math.round((ms / 1000) * fps);
  const minFrames = HLS_SEGMENT_SEC_MIN * fps;
  return Math.max(minFrames, Math.min(150, frames));
}

export function vbvBufsizeKb(ladderId: string | null | undefined, targetLatencyMs: number): number {
  const ladder = resolveEncodeLadder(ladderId);
  const windowSec = Math.max(0.25, clampTargetLatencyMs(targetLatencyMs) / 1000);
  return Math.max(ladder.maxrate_kbps, Math.round(ladder.maxrate_kbps * windowSec * 2));
}

export function srtLatencyUs(targetLatencyMs: number): number {
  return clampTargetLatencyMs(targetLatencyMs) * 1000;
}

/** Recommended Zixi hls_chunk_time (seconds). Min 2s; grows with latency budget. */
export function hlsSegmentSec(targetLatencyMs: number): number {
  const ms = clampTargetLatencyMs(targetLatencyMs);
  return Math.max(
    HLS_SEGMENT_SEC_MIN,
    Math.min(HLS_SEGMENT_SEC_MAX, Math.round(ms / 2000) || HLS_SEGMENT_SEC_MIN),
  );
}

/**
 * hls.js liveSyncDuration (seconds of intentional live buffer).
 * Standard: 2 × segment (4s at the 2s floor). May tighten toward the latency
 * target, but never below one segment — sub-segment sync breaks non-LL Zixi HLS.
 */
export function hlsLiveSyncDurationSec(targetLatencyMs: number): number {
  const ms = clampTargetLatencyMs(targetLatencyMs);
  const segment = hlsSegmentSec(ms);
  const defaultBuf = segment * HLS_LIVE_SYNC_SEGMENTS_DEFAULT;
  const targetSec = ms / 1000;
  const desired = Math.min(defaultBuf, targetSec || defaultBuf);
  return Math.max(segment, Math.min(defaultBuf, desired));
}

export function hlsLiveSyncCount(targetLatencyMs: number): number {
  const segment = hlsSegmentSec(targetLatencyMs);
  const duration = hlsLiveSyncDurationSec(targetLatencyMs);
  return Math.max(1, Math.min(5, Math.round(duration / segment) || 1));
}

export function moqPlayerTargetLatencyMs(targetLatencyMs: number): number {
  return clampTargetLatencyMs(targetLatencyMs);
}

/**
 * MoQ catch-up config.
 *
 * openmoq CMAF does not publish LOC CaptureTimestamps. Enabling maxCatchUpRate
 * with media-timeline timestamps treated as capture times makes the player
 * think latency is huge and warps A/V — reported as "half speed" / rubber-banding.
 * Keep rate at 1.0; live-edge is handled by buffer seek in MoqPlayer.
 */
export function moqCatchUpConfig(targetLatencyMs: number): {
  targetLatencyMs: number;
  maxCatchUpRate: number;
  catchUpThresholdMs: number;
  catchUpRecoveryMs: number;
} {
  const target = clampTargetLatencyMs(targetLatencyMs);
  return {
    targetLatencyMs: target,
    maxCatchUpRate: 1.0,
    catchUpThresholdMs: Math.max(80, Math.round(target * 0.2)),
    catchUpRecoveryMs: Math.max(40, Math.round(target * 0.12)),
  };
}

export interface EncodeProfileSummary {
  encode_ladder: string;
  encode_ladder_label: string;
  height: number;
  bitrate_kbps: number;
  maxrate_kbps: number;
  minrate_kbps: number;
  target_latency_ms: number;
  gop_frames: number;
  keyframe_interval_sec: number;
  vbv_bufsize_kb: number;
  x264_tune: "zerolatency" | null;
  srt_latency_us: number;
  hls_segment_sec: number;
  hls_live_sync_duration_sec: number;
  hls_live_sync_count: number;
  moq_target_latency_ms: number;
  moq_catch_up: ReturnType<typeof moqCatchUpConfig>;
}

/** Mirrors src/encode_profile.encode_profile_summary (+ UI-only VBV / tune). */
export function encodeProfileSummary(
  ladderId: string | null | undefined,
  targetLatencyMs: number | null | undefined,
): EncodeProfileSummary {
  const ladder = resolveEncodeLadder(ladderId);
  const latencyMs = clampTargetLatencyMs(targetLatencyMs ?? DEFAULT_TARGET_LATENCY_MS);
  const gop = gopFramesForLatency(latencyMs);
  return {
    encode_ladder: ladder.id,
    encode_ladder_label: ladder.label,
    height: ladder.height,
    bitrate_kbps: ladder.bitrate_kbps,
    maxrate_kbps: ladder.maxrate_kbps,
    minrate_kbps: ladder.minrate_kbps,
    target_latency_ms: latencyMs,
    gop_frames: gop,
    keyframe_interval_sec: Math.round((gop / ASSUMED_FPS) * 1000) / 1000,
    vbv_bufsize_kb: vbvBufsizeKb(ladder.id, latencyMs),
    x264_tune: latencyMs <= 500 ? "zerolatency" : null,
    srt_latency_us: srtLatencyUs(latencyMs),
    hls_segment_sec: hlsSegmentSec(latencyMs),
    hls_live_sync_duration_sec: hlsLiveSyncDurationSec(latencyMs),
    hls_live_sync_count: hlsLiveSyncCount(latencyMs),
    moq_target_latency_ms: moqPlayerTargetLatencyMs(latencyMs),
    moq_catch_up: moqCatchUpConfig(latencyMs),
  };
}
