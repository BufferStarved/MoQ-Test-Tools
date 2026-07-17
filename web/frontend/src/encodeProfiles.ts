export const MIN_TARGET_LATENCY_MS = 100;
export const MAX_TARGET_LATENCY_MS = 10_000;
export const DEFAULT_TARGET_LATENCY_MS = 800;
export const DEFAULT_ENCODE_LADDER_ID = "720p";

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
