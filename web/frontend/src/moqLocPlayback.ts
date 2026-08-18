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

export type LocStallAction = "ok" | "hold" | "restart" | "give_up";

export function classifyLocFrameStall(input: {
  framesRendered: number;
  lastAdvanceAtMs: number;
  nowMs: number;
  sessionRestarts: number;
  maxRestarts?: number;
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
  if (input.earlyWindow) {
    return "hold";
  }
  if (input.framesRendered > 0) {
    return "hold";
  }
  const maxRestarts = input.maxRestarts ?? LOC_MAX_SESSION_RESTARTS;
  return input.sessionRestarts < maxRestarts ? "restart" : "give_up";
}
