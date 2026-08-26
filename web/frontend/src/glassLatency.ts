/**
 * Cross-protocol glass delay helpers.
 *
 * Browser MoQ LOC stamps CaptureTimestamp as Unix-epoch microseconds; that
 * is true capture→glass **while frames are painting**. If the canvas freezes,
 * locGlassDelayMs adds stall time so a stale frame cannot beat WebRTC at ~30ms. WebRTC WHEP has no capture clock on the RTP, so it
 * uses encode time + RTT/2 + jitter buffer — the same components, same
 * units, so a verdict can rank them. Do not mix those with
 * wall−playhead-from-zero (that series grows 1:1 with a frozen playhead).
 */

import { locGlassDelayMs } from "./playbackTruth.ts";

export const E2E_MIN_MS = 8;
/** Includes freeze-adjusted glass delay (a 36s stall must still plot). */
export const E2E_MAX_MS = 180_000;

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

/**
 * Trimmed mean of plausible glass-delay samples, plus the true worst case.
 *
 * `avg` drops zeros and single-sample freeze spikes (> 3× median) so one stall
 * does not dominate the headline number. `max` is taken *before* that trim: a
 * value labelled "max" must report the worst glass delay actually observed,
 * not the worst that survived outlier rejection.
 */
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
  return { avg, max: filtered[filtered.length - 1] };
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
 *
 * CMAF must not consume playa `stats.latencyMs` — that gauge is LOC
 * CaptureTimestamp. Using it here short-circuited the encode-timeline math.
 */
export function computeMoqE2eMs(options: {
  playerLatencyMs?: number;
  bridgeMs?: number;
  encoderLagMs?: number;
  /** Full capture→muxed component (baseline + lag). Live-edge rebase only. */
  encodeComponentMs?: number;
  rttMs?: number;
  bufferMs?: number;
  mediaPackaging?: MoqMediaPackaging;
  joinOffsetSec?: number | null;
  videoCurrentTimeSec?: number;
  bufferedEndSec?: number | null;
  deliveryOriginSec?: number | null;
  moqTimelineMs?: number;
  epochSec?: number;
  nowMs?: number;
  clockSkewMs?: number;
  ttffMs?: number;
  firstFrameAtMs?: number;
  firstFrameVideoSec?: number;
  lastFrameAtMs?: number;
}): number | undefined {
  const bridge = options.bridgeMs ?? 0;
  const now = options.nowMs ?? Date.now();
  const skew = options.clockSkewMs ?? 0;
  const epoch = options.epochSec ?? 0;
  const videoT = options.videoCurrentTimeSec ?? 0;

  // LOC: last CaptureTimestamp is NOT glass delay while the canvas is frozen.
  // Add stall time so a dead playhead cannot "win" vs WebRTC at ~30ms.
  if (options.mediaPackaging === "loc") {
    return locGlassDelayMs({
      playerLatencyMs: options.playerLatencyMs,
      lastFrameAtMs: options.lastFrameAtMs,
      firstFrameAtMs: options.firstFrameAtMs,
      nowMs: now,
      bridgeMs: bridge,
      encodeLagMs: options.encoderLagMs,
      rttMs: options.rttMs,
      bufferMs: options.bufferMs,
    });
  }

  // Everything below is the CMAF path: LOC returned above. playa latencyMs
  // is CaptureTimestamp — do not treat it as CMAF glass.

  const join = options.joinOffsetSec;
  if (join != null && join > 1e6 && videoT > 0.05) {
    const mediaPosSec = join + videoT;
    const total = now + skew - mediaPosSec * 1000 + bridge;
    if (isPlausibleE2eMs(total)) {
      return Math.round(total);
    }
  }

  const bufferedEnd =
    options.bufferedEndSec ??
    (options.bufferMs != null && videoT >= 0 ? videoT + options.bufferMs / 1000 : null);
  const anchored = encodeAnchoredE2eMs({
    epochSec: epoch,
    rawVideoTimeSec: videoT,
    nowMs: now,
    clockSkewMs: skew,
    bridgeMs: bridge,
    deliveryOriginSec: options.deliveryOriginSec,
    joinOffsetSec: join,
    bufferedEndSec: bufferedEnd,
    encodeComponentMs: options.encodeComponentMs ?? options.encoderLagMs,
  });
  if (anchored) {
    return anchored;
  }

  const timelineMs = options.moqTimelineMs ?? 0;
  if (epoch > 0 && timelineMs > 50) {
    const total = now + skew - epoch * 1000 - timelineMs + bridge;
    if (isPlausibleE2eMs(total)) {
      return Math.round(total);
    }
  }

  // LOC glass is capture→now. Do not use playheadAnchored here for LOC — that
  // is why it returns above: videoTime is often framesRendered/30, so dropped
  // frames make e2e climb 1:1 with wall even when the canvas delay is steady.
  const playheadAnchored = playheadAnchoredE2eMs({
    ttffMs: options.ttffMs,
    firstFrameAtMs: options.firstFrameAtMs,
    firstFrameVideoSec: options.firstFrameVideoSec,
    nowMs: now,
    videoTimeSec: videoT,
    bridgeMs: bridge,
  });
  if (playheadAnchored) {
    return playheadAnchored;
  }

  return pathDelayMs({
    encodeLagMs: options.encoderLagMs,
    rttMs: options.rttMs,
    playerBufferMs: (options.bufferMs ?? 0) + bridge,
  });
}

/** Join offset is media-timeline (tfdt), not wall-clock attach delay. */
export function isMediaTimelineJoinOffset(
  joinOffsetSec: number | null | undefined,
  videoTimeSec: number,
  wallSinceEpochSec: number,
): joinOffsetSec is number {
  if (joinOffsetSec == null || !Number.isFinite(joinOffsetSec) || joinOffsetSec < 0) {
    return false;
  }
  // Wall-attach: join ≈ how late we attached and currentTime is still
  // session-from-0. Match the live-edge rebase window (`vt < 1.5`) so a
  // first-paint join at vt≈1.0 cannot leak as tfdt (comparison 26).
  if (
    videoTimeSec < 1.5 &&
    wallSinceEpochSec > 2 &&
    Math.abs(joinOffsetSec - wallSinceEpochSec) < 1.25
  ) {
    return false;
  }
  return true;
}

/**
 * Encode-timeline position of the painted frame.
 *
 * Prefer publisher tfdt / delivery origin. If currentTime is still near 0
 * while wall−epoch is large, rebase off the live edge (same class as Fast
 * HLS `deliveryMediaOriginSec`) so e2e is capture→glass of that frame —
 * not "how late we attached". Returns undefined rather than a confident
 * join-offset glass number when nothing encode-anchors the playhead.
 */
export type EncodeMediaAnchorKind = "join" | "delivery" | "live-edge" | "raw";

export type EncodeMediaAnchor = {
  mediaPosSec: number;
  kind: EncodeMediaAnchorKind;
};

/**
 * Encode-timeline position of the painted frame, plus how it was anchored.
 *
 * `live-edge` means CMAF `currentTime` is session-from-0 and join/tfdt was
 * missing or rejected — rebase off `bufferedEnd` for the *whole* run.
 * Using raw `currentTime` after `vt > 1.5` baked a flat ~4.5s above buffer
 * (comparison 26).
 */
export function resolveEncodeMediaAnchor(options: {
  rawVideoTimeSec: number;
  epochSec: number;
  nowMs?: number;
  clockSkewMs?: number;
  deliveryOriginSec?: number | null;
  joinOffsetSec?: number | null;
  bufferedEndSec?: number | null;
}): EncodeMediaAnchor | undefined {
  const videoT = options.rawVideoTimeSec;
  const epoch = options.epochSec;
  if (!Number.isFinite(videoT) || videoT < 0) {
    return undefined;
  }
  const now = options.nowMs ?? Date.now();
  const skew = options.clockSkewMs ?? 0;
  const wallSec = epoch > 0 ? (now + skew) / 1000 - epoch : 0;
  const join = options.joinOffsetSec;

  if (isMediaTimelineJoinOffset(join, videoT, wallSec)) {
    return { mediaPosSec: join + videoT, kind: "join" };
  }
  if (options.deliveryOriginSec != null && Number.isFinite(options.deliveryOriginSec)) {
    return { mediaPosSec: options.deliveryOriginSec + videoT, kind: "delivery" };
  }
  const bufferedEnd = options.bufferedEndSec;
  // Session-relative currentTime + large wall−epoch is join offset, not the
  // painted frame — for the whole run, not only vt < 1.5. Live edge of the
  // HTML buffer is the newest received media; treat that as "now".
  if (
    epoch > 0 &&
    wallSec > 2.5 &&
    bufferedEnd != null &&
    Number.isFinite(bufferedEnd) &&
    bufferedEnd >= videoT
  ) {
    return { mediaPosSec: wallSec - bufferedEnd + videoT, kind: "live-edge" };
  }
  // Last resort when nothing queued the live edge: encode-anchored
  // currentTime (origin 0). Do not take this path when bufferedEnd exists.
  if (epoch > 0 && videoT > 1.5 && wallSec - videoT > 0.05 && wallSec - videoT < 60) {
    return { mediaPosSec: videoT, kind: "raw" };
  }
  return undefined;
}

export function resolveEncodeMediaPosSec(options: {
  rawVideoTimeSec: number;
  epochSec: number;
  nowMs?: number;
  clockSkewMs?: number;
  deliveryOriginSec?: number | null;
  joinOffsetSec?: number | null;
  bufferedEndSec?: number | null;
}): number | undefined {
  return resolveEncodeMediaAnchor(options)?.mediaPosSec;
}

export function encodeAnchoredE2eMs(options: {
  epochSec: number;
  rawVideoTimeSec: number;
  nowMs?: number;
  clockSkewMs?: number;
  bridgeMs?: number;
  deliveryOriginSec?: number | null;
  joinOffsetSec?: number | null;
  bufferedEndSec?: number | null;
  encodeComponentMs?: number;
}): number | undefined {
  const epoch = options.epochSec;
  if (!(epoch > 0)) {
    return undefined;
  }
  const anchor = resolveEncodeMediaAnchor(options);
  if (anchor == null) {
    return undefined;
  }
  const now = options.nowMs ?? Date.now();
  const skew = options.clockSkewMs ?? 0;
  const bridge = options.bridgeMs ?? 0;
  let total = now + skew - epoch * 1000 - anchor.mediaPosSec * 1000 + bridge;
  // Live-edge rebase is hold only (wall − live + playhead). Capture-class
  // glass still includes encode; tfdt/delivery anchors already contain it.
  if (anchor.kind === "live-edge") {
    total += Math.max(0, options.encodeComponentMs ?? 0);
  }
  return isPlausibleE2eMs(total) ? Math.round(total) : undefined;
}

const PLAYHEAD_STALL_EPS_SEC = 0.05;

/**
 * A frozen playhead is not +1s/s of glass delay. Hold the last reading
 * taken while the painted frame was still advancing (including a Go Live
 * seek, which jumps currentTime forward).
 */
export function holdE2eWhilePlayheadFrozen(
  computed: number | undefined,
  videoTimeSec: number,
  last: { videoTimeSec: number; e2eMs: number } | undefined,
): { e2eMs: number | undefined; last: { videoTimeSec: number; e2eMs: number } | undefined } {
  if (computed == null) {
    return { e2eMs: last?.e2eMs, last };
  }
  if (
    last &&
    Number.isFinite(videoTimeSec) &&
    Math.abs(videoTimeSec - last.videoTimeSec) <= PLAYHEAD_STALL_EPS_SEC
  ) {
    return { e2eMs: last.e2eMs, last };
  }
  return { e2eMs: computed, last: { videoTimeSec, e2eMs: computed } };
}

/**
 * Drop a one-shot packager transit that is just (PDT−anchor − 1s).
 * PDT is already packaging-time; adding that snapshot overstated every
 * later LL-HLS sample (comparison 2026-08-23: 4.6s stuck for the run).
 */
export function usablePackagerTransitMs(options: {
  transitMs?: number | null;
  playheadPdtMs?: number;
  epochSec?: number;
}): number {
  const transit = options.transitMs;
  if (transit == null || !(transit > 0) || !Number.isFinite(transit)) {
    return 0;
  }
  const pdt = options.playheadPdtMs ?? 0;
  const epoch = options.epochSec ?? 0;
  if (pdt > 0 && epoch > 0) {
    const elapsedSec = pdt / 1000 - epoch;
    if (elapsedSec > 2 && Math.abs(transit / 1000 - (elapsedSec - 1)) < 0.4) {
      return 0;
    }
  }
  return transit;
}
