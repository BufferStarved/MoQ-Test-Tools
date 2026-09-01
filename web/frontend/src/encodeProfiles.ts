export const MIN_TARGET_LATENCY_MS = 100;
/** SRT jobs are floored server-side at 2000 ms for stable libsrt / LL-HLS delivery. */
export const SRT_MIN_TARGET_LATENCY_MS = 2000;
export const MAX_TARGET_LATENCY_MS = 10_000;
/** HLS / SRT / Zixi: 2s is the lowest stable segmented-delivery budget. */
export const DEFAULT_TARGET_LATENCY_MS = 2000;
/** MoQ has no segments — player hold and GOP use this, not the HLS 2s floor. */
export const DEFAULT_MOQ_TARGET_LATENCY_MS = 400;
export const DEFAULT_ENCODE_LADDER_ID = "720p";
export const ASSUMED_FPS = 30;

/** Mirrors src/encode_profile.py — Zixi HLS chunk floor (1s packs stutter). */
export const HLS_SEGMENT_SEC_MIN = 2;
export const HLS_SEGMENT_SEC_MAX = 6;
export const HLS_LIVE_SYNC_SEGMENTS_DEFAULT = 2;
export const HLS_LIVE_SYNC_DURATION_SEC_MIN = 1;
/** Solo/file MoQ only. Shared broker master stays at 1s (do not drop it). */
export const MOQ_GOP_SEC_MIN = 0.25;
export const MOQ_GOP_SEC_MAX = 1.0;
/** Matches webcam_broker.MASTER_GOP_FRAMES @ 30fps — dest_count < 2 still copies this. */
export const BROKER_GOP_MS = 1000;
/** MediaMTX LL-HLS part duration. Not a 1s CMAF group. */
export const LL_HLS_PART_MS = 200;
/** Uniform IDR cadence for TS/HLS delivery (mirrors DELIVERY_GOP_SEC). */
export const DELIVERY_GOP_SEC = 1;

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

/**
 * Keyframe interval == intended HLS segment duration (mirrors
 * src/encode_profile.py). Packagers cut segments on IDRs only, so a GOP
 * sized to the whole latency budget silently stretched every segment to
 * match — which doubled again in the player's 2-segment live buffer.
 */
export function gopFramesForLatency(targetLatencyMs: number, fps = ASSUMED_FPS): number {
  const seconds = hlsSegmentSec(clampTargetLatencyMs(targetLatencyMs));
  return Math.max(fps, Math.min(150, Math.round(seconds * fps)));
}

export function vbvBufsizeKb(ladderId: string | null | undefined, targetLatencyMs: number): number {
  const ladder = resolveEncodeLadder(ladderId);
  const windowSec = Math.max(0.25, clampTargetLatencyMs(targetLatencyMs) / 1000);
  return Math.max(ladder.maxrate_kbps, Math.round(ladder.maxrate_kbps * windowSec * 2));
}

export function srtLatencyUs(targetLatencyMs: number): number {
  return clampTargetLatencyMs(targetLatencyMs) * 1000;
}

/** Recommended Zixi hls_chunk_time (seconds). Min 2s; grows with latency budget.
 *  Floor (not round) so 5s target stays on 2s chunks — matches Python
 *  encode_profile.hls_segment_sec and Zixi's default hls_chunk_time. */
export function hlsSegmentSec(targetLatencyMs: number): number {
  const ms = clampTargetLatencyMs(targetLatencyMs);
  return Math.max(
    HLS_SEGMENT_SEC_MIN,
    Math.min(HLS_SEGMENT_SEC_MAX, Math.floor(ms / 2000) || HLS_SEGMENT_SEC_MIN),
  );
}

/**
 * hls.js liveSyncDuration (seconds of intentional live buffer).
 * Standard: 2 × segment (4s at the 2s floor). May tighten toward the latency
 * target, but never below one segment — sub-segment sync breaks non-LL Zixi HLS
 * (measured: chasing sub-TARGETDURATION left the playhead starving between
 * 2s chunks). MediaMTX LL-HLS uses part-level defaults instead (see HlsPlayer).
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

/**
 * IDR cadence actually used by every delivery leg (mirrors
 * src/encode_profile.delivery_gop_frames): 1s, or segment/2 for long segments.
 * A GOP only has to divide the chunk, not equal it — keying Zixi's GOP to
 * hls_chunk_time put a needless 2s floor under RTMP/SRT TTFF.
 */
export function deliveryGopFrames(targetLatencyMs: number, fps = ASSUMED_FPS): number {
  const segment = hlsSegmentSec(clampTargetLatencyMs(targetLatencyMs));
  return Math.max(1, Math.round(Math.max(DELIVERY_GOP_SEC, segment / 2) * fps));
}

export function moqGopFramesForLatency(targetLatencyMs: number, fps = ASSUMED_FPS): number {
  const ms = clampTargetLatencyMs(targetLatencyMs);
  const seconds = Math.min(MOQ_GOP_SEC_MAX, Math.max(MOQ_GOP_SEC_MIN, ms / 2000));
  return Math.max(1, Math.round(seconds * fps));
}

/** Closed-group duration the NextGroupStart subscriber waits — not ingest RTT. */
export function moqGroupDurationMs(
  targetLatencyMs: number,
  options: { brokered?: boolean; destCount?: number; fps?: number } = {},
): number {
  const destCount = options.destCount ?? 1;
  if (options.brokered && destCount < 2) {
    return BROKER_GOP_MS;
  }
  const fps = options.fps ?? ASSUMED_FPS;
  return Math.round((moqGopFramesForLatency(targetLatencyMs, fps) / fps) * 1000 * 10) / 10;
}

/** Shared webcam broker loopback — file / BBB / dummy must not match this. */
export function isBrokeredWebcamMedia(mediaPath: string | null | undefined): boolean {
  return (mediaPath || "").trim().toLowerCase().startsWith("udp://");
}

/**
 * `latency_segmentation_ms` for the publisher hop. File and cloud playout
 * use the solo MoQ GOP. dest_count < 2 on a brokered hop still reports 1s.
 */
export function segmentationMsForPublish(
  protocol: string,
  targetLatencyMs: number,
  options: { mediaPath?: string; brokered?: boolean; destCount?: number } = {},
): { ms: number | null; notApplicable: boolean } {
  const proto = (protocol || "").trim().toLowerCase();
  if (proto === "webrtc") {
    return { ms: null, notApplicable: true };
  }
  if (proto === "moq") {
    const brokered = options.brokered ?? isBrokeredWebcamMedia(options.mediaPath);
    return {
      ms: moqGroupDurationMs(targetLatencyMs, { brokered, destCount: options.destCount }),
      notApplicable: false,
    };
  }
  if (proto === "hls") {
    return { ms: LL_HLS_PART_MS, notApplicable: false };
  }
  if (proto === "srt" || proto === "rtmp" || proto === "http") {
    return { ms: null, notApplicable: true };
  }
  return { ms: null, notApplicable: false };
}

export function moqPlayerTargetLatencyMs(targetLatencyMs?: number): number {
  const ms = clampTargetLatencyMs(targetLatencyMs ?? DEFAULT_MOQ_TARGET_LATENCY_MS);
  if (ms >= SRT_MIN_TARGET_LATENCY_MS) {
    return DEFAULT_MOQ_TARGET_LATENCY_MS;
  }
  return ms;
}

/**
 * MoQ catch-up config.
 *
 * openmoq CMAF does not publish LOC CaptureTimestamps. Enabling maxCatchUpRate
 * with media-timeline timestamps treated as capture times makes the player
 * think latency is huge and warps A/V — reported as "half speed" / rubber-banding.
 * Keep CMAF at 1.0; live-edge is handled by buffer seek in MoqPlayer.
 *
 * Browser LOC *does* stamp CaptureTimestamp. A 1.0 rate left both east and
 * Linode players falling behind (~16 fps) until the canvas froze at ~9s.
 */
export function moqCatchUpConfig(
  targetLatencyMs?: number,
  packaging: "cmaf" | "loc" = "cmaf",
  playbackPolicy: "live-edge" | "complete" = "live-edge",
): {
  targetLatencyMs: number;
  maxCatchUpRate: number;
  catchUpThresholdMs: number;
  catchUpRecoveryMs: number;
} {
  const target = moqPlayerTargetLatencyMs(targetLatencyMs);
  return {
    targetLatencyMs: target,
    maxCatchUpRate: packaging === "loc" && playbackPolicy !== "complete" ? 1.25 : 1.0,
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
  delivery_gop_frames: number;
  keyframe_interval_sec: number;
  vbv_bufsize_kb: number;
  x264_tune: "zerolatency" | null;
  srt_latency_us: number;
  hls_segment_sec: number;
  hls_live_sync_duration_sec: number;
  hls_live_sync_count: number;
  moq_target_latency_ms: number;
  moq_gop_frames: number;
  moq_catch_up: ReturnType<typeof moqCatchUpConfig>;
}

/** Mirrors src/encode_profile.encode_profile_summary (+ UI-only VBV / tune). */
export function encodeProfileSummary(
  ladderId: string | null | undefined,
  targetLatencyMs: number | null | undefined,
): EncodeProfileSummary {
  const ladder = resolveEncodeLadder(ladderId);
  const latencyMs = clampTargetLatencyMs(targetLatencyMs ?? DEFAULT_TARGET_LATENCY_MS);
  const gop = deliveryGopFrames(latencyMs);
  const moqMs = moqPlayerTargetLatencyMs(latencyMs);
  return {
    encode_ladder: ladder.id,
    encode_ladder_label: ladder.label,
    height: ladder.height,
    bitrate_kbps: ladder.bitrate_kbps,
    maxrate_kbps: ladder.maxrate_kbps,
    minrate_kbps: ladder.minrate_kbps,
    target_latency_ms: latencyMs,
    gop_frames: gop,
    delivery_gop_frames: gop,
    keyframe_interval_sec: Math.round((gop / ASSUMED_FPS) * 1000) / 1000,
    vbv_bufsize_kb: vbvBufsizeKb(ladder.id, latencyMs),
    x264_tune: latencyMs <= 500 ? "zerolatency" : null,
    srt_latency_us: srtLatencyUs(latencyMs),
    hls_segment_sec: hlsSegmentSec(latencyMs),
    hls_live_sync_duration_sec: hlsLiveSyncDurationSec(latencyMs),
    hls_live_sync_count: hlsLiveSyncCount(latencyMs),
    moq_target_latency_ms: moqMs,
    moq_gop_frames: moqGopFramesForLatency(moqMs),
    moq_catch_up: moqCatchUpConfig(moqMs),
  };
}
