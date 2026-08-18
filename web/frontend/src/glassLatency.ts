/**
 * Cross-protocol glass delay helpers.
 *
 * Browser MoQ LOC stamps CaptureTimestamp as Unix-epoch microseconds; that
 * is true capture→glass. WebRTC WHEP has no capture clock on the RTP, so it
 * uses encode time + RTT/2 + jitter buffer — the same components, same
 * units, so a verdict can rank them. Do not mix those with
 * wall−playhead-from-zero (that series grows 1:1 with a frozen playhead).
 */

export const E2E_MIN_MS = 8;
export const E2E_MAX_MS = 30_000;

export function isPlausibleE2eMs(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= E2E_MIN_MS && value < E2E_MAX_MS;
}

/** CaptureTimestamp is Unix-epoch µs. Media-timeline µs (WebCodecs PTS) is not. */
export function captureTimestampLatencyMs(
  captureTimestampUs: number,
  nowMs = Date.now(),
): number | undefined {
  if (!Number.isFinite(captureTimestampUs) || captureTimestampUs <= 0) {
    return undefined;
  }
  const captureMs = captureTimestampUs / 1000;
  if (captureMs < 1e12) {
    return undefined;
  }
  const latency = nowMs - captureMs;
  return isPlausibleE2eMs(latency) ? Math.round(latency) : undefined;
}

export function pathDelayMs(options: {
  encodeLagMs?: number;
  rttMs?: number;
  playerBufferMs?: number;
  decodeMs?: number;
}): number | undefined {
  const encode = Math.max(0, options.encodeLagMs ?? 0);
  const net = Math.max(0, (options.rttMs ?? 0) / 2);
  const buf = Math.max(0, options.playerBufferMs ?? 0);
  const decode = Math.max(0, options.decodeMs ?? 0);
  const total = encode + net + buf + decode;
  return isPlausibleE2eMs(total) ? Math.round(total) : undefined;
}

/** Drop zeros and freeze-runaways, then average the remaining healthy samples. */
export function robustE2eStats(values: number[]): { avg: number; max: number } | null {
  const filtered = values.filter(isPlausibleE2eMs).sort((a, b) => a - b);
  if (filtered.length === 0) {
    return null;
  }
  const mid = Math.floor(filtered.length / 2);
  const median =
    filtered.length % 2 === 1 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2;
  const cap = Math.max(median * 3, 5_000);
  const healthy = filtered.filter((value) => value <= cap);
  const pool = healthy.length ? healthy : filtered;
  const avg = pool.reduce((sum, value) => sum + value, 0) / pool.length;
  return { avg, max: pool[pool.length - 1] };
}

export function playbackFpsFromCounters(
  framesRendered: number,
  elapsedSec: number,
): number | undefined {
  if (!(framesRendered > 0) || !(elapsedSec > 0.5)) {
    return undefined;
  }
  const fps = framesRendered / elapsedSec;
  return fps > 0.5 && fps < 120 ? fps : undefined;
}

/**
 * Glass delay from TTFF + playhead progress. Does not need an encode epoch:
 * while frames advance with the wall clock the value stays near TTFF; a
 * freeze grows it (then the player holds the last good sample).
 */
export function playheadAnchoredE2eMs(options: {
  ttffMs?: number;
  firstFrameAtMs?: number;
  firstFrameVideoSec?: number;
  nowMs?: number;
  videoTimeSec?: number;
  bridgeMs?: number;
}): number | undefined {
  const ttff = Math.max(0, options.ttffMs ?? 0);
  const firstAt = options.firstFrameAtMs ?? 0;
  const firstVt = options.firstFrameVideoSec ?? 0;
  const now = options.nowMs ?? Date.now();
  const vt = options.videoTimeSec ?? 0;
  const bridge = options.bridgeMs ?? 0;
  if (firstAt > 0 && vt >= firstVt) {
    const wallSinceFirst = now - firstAt;
    const mediaSinceFirst = (vt - firstVt) * 1000;
    const total = ttff + (wallSinceFirst - mediaSinceFirst) + bridge;
    return isPlausibleE2eMs(total) ? Math.round(total) : undefined;
  }
  if (ttff >= E2E_MIN_MS) {
    const total = ttff + bridge;
    return isPlausibleE2eMs(total) ? Math.round(total) : undefined;
  }
  return undefined;
}

export type MoqMediaPackaging = "cmaf" | "loc";

/**
 * MoQ glass delay. Same family as WHEP (`pathDelayMs`) when capture/join
 * clocks are missing — cloud ffmpeg CMAF has no CaptureTimestamp and
 * `joinMediaOffsetSec` is often null, which used to leave e2e as a column
 * of zeros while frames were on screen (comparison CSV 2026-08-18).
 */
export function computeMoqE2eMs(options: {
  playerLatencyMs?: number;
  bridgeMs?: number;
  encoderLagMs?: number;
  rttMs?: number;
  bufferMs?: number;
  mediaPackaging?: MoqMediaPackaging;
  joinOffsetSec?: number | null;
  videoCurrentTimeSec?: number;
  moqTimelineMs?: number;
  epochSec?: number;
  nowMs?: number;
  clockSkewMs?: number;
  ttffMs?: number;
  firstFrameAtMs?: number;
  firstFrameVideoSec?: number;
}): number | undefined {
  const bridge = options.bridgeMs ?? 0;
  const now = options.nowMs ?? Date.now();
  const skew = options.clockSkewMs ?? 0;
  const epoch = options.epochSec ?? 0;
  const videoT = options.videoCurrentTimeSec ?? 0;

  if (isPlausibleE2eMs(options.playerLatencyMs)) {
    const total = options.playerLatencyMs + bridge;
    if (isPlausibleE2eMs(total)) {
      return Math.round(total);
    }
  }

  if (options.mediaPackaging !== "loc") {
    const join = options.joinOffsetSec;
    if (join != null && videoT > 0.05) {
      const mediaPosSec = join + videoT;
      if (mediaPosSec > 1e6) {
        const total = now + skew - mediaPosSec * 1000 + bridge;
        if (isPlausibleE2eMs(total)) {
          return Math.round(total);
        }
      } else if (epoch > 0) {
        const total = now + skew - epoch * 1000 - mediaPosSec * 1000 + bridge;
        if (isPlausibleE2eMs(total)) {
          return Math.round(total);
        }
      }
    }

    const timelineMs = options.moqTimelineMs ?? 0;
    if (epoch > 0 && timelineMs > 50) {
      const total = now + skew - epoch * 1000 - timelineMs + bridge;
      if (isPlausibleE2eMs(total)) {
        return Math.round(total);
      }
    }
    if (epoch > 0 && videoT > 0.05) {
      const total = now + skew - epoch * 1000 - videoT * 1000 + bridge;
      if (isPlausibleE2eMs(total)) {
        return Math.round(total);
      }
    }
  }

  const anchored = playheadAnchoredE2eMs({
    ttffMs: options.ttffMs,
    firstFrameAtMs: options.firstFrameAtMs,
    firstFrameVideoSec: options.firstFrameVideoSec,
    nowMs: now,
    videoTimeSec: videoT,
    bridgeMs: bridge,
  });
  if (anchored) {
    return anchored;
  }

  return pathDelayMs({
    encodeLagMs: options.encoderLagMs,
    rttMs: options.rttMs,
    playerBufferMs: (options.bufferMs ?? 0) + bridge,
  });
}
