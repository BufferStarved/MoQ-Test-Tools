/**
 * Honest glass-side counters for engines that don't report drops.
 *
 * @playa/player `framesDropped` is stubbed at 0 ("deferred to Item 7").
 * Browser MoQ LOC paints a <canvas>, so HTMLVideoElement dropped-frame
 * counters stay 0 too. Testers still see missed frames. Infer them from
 * painted frames vs wall clock after first paint.
 *
 * Frozen LOC also kept posting the last CaptureTimestamp delay (~20–30ms)
 * as e2e while the canvas showed a stale frame. Add stall time so a freeze
 * cannot "win" against a healthy WebRTC line.
 */

export const DEFAULT_PLAYBACK_FPS = 30;
export const FRAME_STALL_MS = 800;
export const STALL_E2E_MAX_MS = 180_000;

export function inferDroppedFrames(options: {
  framesRendered: number;
  reportedDropped?: number;
  firstFrameAtMs: number;
  nowMs?: number;
  targetFps?: number;
}): number {
  const reported = Math.max(0, Math.floor(options.reportedDropped ?? 0));
  const rendered = Math.max(0, Math.floor(options.framesRendered));
  if (options.firstFrameAtMs <= 0 || rendered <= 0) {
    return reported;
  }
  const now = options.nowMs ?? Date.now();
  const elapsedSec = (now - options.firstFrameAtMs) / 1000;
  if (elapsedSec < 0.45) {
    return reported;
  }
  const fps =
    options.targetFps && options.targetFps > 1 && options.targetFps < 120
      ? options.targetFps
      : DEFAULT_PLAYBACK_FPS;
  const expected = Math.round(fps * elapsedSec);
  const inferred = Math.max(0, expected - rendered);
  return Math.max(reported, inferred);
}

/** Seconds of encode the canvas is behind live. 0 while keeping up. */
export function canvasBehindLiveSec(options: {
  framesRendered: number;
  firstFrameAtMs: number;
  nowMs?: number;
  targetFps?: number;
}): number {
  const fps =
    options.targetFps && options.targetFps > 1 && options.targetFps < 120
      ? options.targetFps
      : DEFAULT_PLAYBACK_FPS;
  const dropped = inferDroppedFrames(options);
  return dropped > 0 ? dropped / fps : 0;
}

export function locGlassDelayMs(options: {
  playerLatencyMs?: number;
  lastFrameAtMs?: number;
  nowMs?: number;
  bridgeMs?: number;
  encodeLagMs?: number;
  rttMs?: number;
  bufferMs?: number;
}): number | undefined {
  const now = options.nowMs ?? Date.now();
  const lastAt = options.lastFrameAtMs ?? 0;
  const stallMs = lastAt > 0 ? Math.max(0, now - lastAt) : 0;
  const frozen = stallMs >= FRAME_STALL_MS;
  const paint = options.playerLatencyMs;
  let base: number | undefined;
  if (paint != null && Number.isFinite(paint) && paint >= 8) {
    base = paint;
  } else {
    const encode = Math.max(0, options.encodeLagMs ?? 0);
    const net = Math.max(0, (options.rttMs ?? 0) / 2);
    const buf = Math.max(0, options.bufferMs ?? 0);
    const path = encode + net + buf;
    base = path >= 8 ? path : frozen ? 0 : undefined;
  }
  if (base == null) {
    return undefined;
  }
  const total = base + (frozen ? stallMs : 0) + Math.max(0, options.bridgeMs ?? 0);
  if (!Number.isFinite(total) || total < 8 || total >= STALL_E2E_MAX_MS) {
    return undefined;
  }
  return Math.round(total);
}
