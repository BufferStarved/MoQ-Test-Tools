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
