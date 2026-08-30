/**
 * LOC (browser webcam) subscribe / stall policy for Playa.
 *
 * NextGroupStart on moqx delivered one GOP then never attached later groups.
 * LargestObject is correct for live objects, but warm-start FETCH of the
 * *current* open GOP has the same failure mode when the publisher never
 * starts a new group (no IDR): the player renders that one GOP (~9s at
 * 30 fps) and then wedges. Join at the live edge and wait for the next IDR.
 */

export const LOC_LATE_FRAME_THRESHOLD_MS = 30_000;
export const LOC_MAX_SESSION_RESTARTS = 3;

/**
 * One leftover playa frame with 0x10 and bitrate 0 is not paint
 * (ca7bbb62 GCP East `rendered=1` then loc_frames_frozen_1).
 */
export function locPaintedOk(options: {
  framesRendered?: number;
  bitrateBps?: number;
  subscribeRejected?: boolean;
}): boolean {
  const frames = options.framesRendered ?? 0;
  if (frames <= 0) {
    return false;
  }
  // One leftover playa frame with no bitrate is not paint — 0x10 optional.
  if (frames === 1 && (options.bitrateBps ?? 0) <= 0) {
    return false;
  }
  return true;
}

export function locSubscribeOptions(): {
  subscriptionFilter: { type: "LargestObject" };
  warmStartCurrentGroup: false;
  lateFrameThresholdMs: number;
} {
  return {
    subscriptionFilter: { type: "LargestObject" },
    warmStartCurrentGroup: false,
    lateFrameThresholdMs: LOC_LATE_FRAME_THRESHOLD_MS,
  };
}

export type LocStallAction = "ok" | "hold" | "reset" | "restart" | "give_up";

export const LOC_MAX_DECODER_RESETS = 2;

/**
 * Reset playa's video pipeline without tearing the WebTransport session.
 * pause()+play() is forbidden here — pause sends FORWARD=0 and freezes the
 * live subscribe at the relay.
 */
/**
 * playa emits catalog_received before createPipelines, so the first play()
 * sees renderer=null. A second play() then throws PLAYING→PLAYING and
 * never reaches renderer.start() — VideoDecoder can emit into a queue
 * that never rAF-ticks (1f61f56d group 53 / rendered=0).
 */
export function startLocCanvasRenderer(player: object | null | undefined): boolean {
  if (!player) {
    return false;
  }
  const loc = player as { play?: () => void; renderer?: { start?: () => void } };
  try {
    loc.play?.();
  } catch {
    // already PLAYING — still start the renderer created after catalog_received
  }
  const renderer = loc.renderer;
  if (typeof renderer?.start !== "function") {
    return false;
  }
  renderer.start();
  return true;
}

export function resetLocPlaybackPipeline(player: object | null | undefined): boolean {
  if (!player) {
    return false;
  }
  const engine = (player as { engine?: {
    videoPipeline?: { reset?: (id?: bigint) => void };
    syncController?: { reset?: () => void };
  } }).engine;
  if (typeof engine?.videoPipeline?.reset !== "function") {
    return false;
  }
  engine.videoPipeline.reset();
  engine.syncController?.reset?.();
  startLocCanvasRenderer(player);
  return true;
}

export function classifyLocFrameStall(input: {
  framesRendered: number;
  lastAdvanceAtMs: number;
  nowMs: number;
  sessionRestarts: number;
  maxRestarts?: number;
  decoderResets?: number;
  maxDecoderResets?: number;
  stallLimitMs: number;
  retrying: boolean;
  /** First 15s after first paint — waiting for the next IDR, not a dead WT. */
  earlyWindow?: boolean;
  /** Job completed/failed — leftover objects are EOS, not a stall. */
  encodeFinished?: boolean;
}): LocStallAction {
  if (input.retrying) {
    return "ok";
  }
  if (input.nowMs - input.lastAdvanceAtMs <= input.stallLimitMs) {
    return "ok";
  }
  // Reconnect RESET_STREAMs every live subscriber (publisher + recorder).
  // Prod demo 2026-08-18: 4 frames, then restart 1/3–3/3 loc_frames_frozen
  // *_early_join — each resubscribe joined the same dead live edge.
  if (input.encodeFinished) {
    return "hold";
  }
  const maxResets = input.maxDecoderResets ?? LOC_MAX_DECODER_RESETS;
  const resets = input.decoderResets ?? 0;
  // Early join and first paints: reset the decoder only. Do not destroy the
  // session — that RESET_STREAMs the publisher. After the reset budget, a
  // later restart is better than a dead canvas for the rest of the run.
  if (resets < maxResets) {
    return "reset";
  }
  if (input.earlyWindow) {
    return "hold";
  }
  const maxRestarts = input.maxRestarts ?? LOC_MAX_SESSION_RESTARTS;
  return input.sessionRestarts < maxRestarts ? "restart" : "give_up";
}
