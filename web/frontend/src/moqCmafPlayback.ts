/**
 * CMAF (ffmpeg / openmoq-publisher) subscribe + end-of-run policy.
 *
 * moqx catalog is a one-shot group-0 object. Tearing down on 0x10
 * ("no such namespace or track") leaves a gap where the catalog is
 * published to nobody — then AbsoluteStart {0,0} retries see nothing.
 * Encode/CMAF metrics keep ticking; the player stays black with no error
 * (comparison CSV 2026-08-18: frames=0, ttff=0, error_count=0, e2e≠0).
 */

export const MOQ_ALL_TRACKS_REFUSED = 4867;
export const MOQ_SUBSCRIPTION_REFUSED = 4866;
export const MOQ_LOAD_FAILED = 4865;

/** Stay connected through publisher-not-ready; do not burn the one-shot catalog. */
export const SUBSCRIBE_KEEPALIVE_ON_0X10 = true;

/** Fail the visible player if nothing rendered by then (fits a 60s BBB). */
export const MOQ_NO_MEDIA_TIMEOUT_MS = 15_000;

/** MSE still has a GOP-sized lead — do not tear down a live-edge join. */
export const CMAF_BUFFERED_HOLD_SEC = 0.35;
/** Playhead that has actually started (MSE join), not a reconnect reset. */
export const CMAF_JOINED_PLAYHEAD_SEC = 0.25;
/** Same class of late-frame floor as the previous inline CMAF config. */
export const CMAF_LATE_FRAME_THRESHOLD_MS = 400;

/**
 * Live CMAF subscribe: NextGroupStart at the next keyframe, no joining
 * FETCH of the open group. moqx honored a warm-start / mid-stream FETCH
 * for one GOP (~0.5–1s) and never attached later groups — same stall as
 * LOC. Catalog init comes from the publisher; do not fetch the open GOP.
 */
export function cmafSubscribeOptions(): {
  subscriptionFilter: { type: "NextGroupStart" };
  warmStartCurrentGroup: false;
  lateFrameThresholdMs: number;
} {
  return {
    subscriptionFilter: { type: "NextGroupStart" },
    warmStartCurrentGroup: false,
    lateFrameThresholdMs: CMAF_LATE_FRAME_THRESHOLD_MS,
  };
}

/** CMAF paints MSE on <video>; LOC paints WebCodecs on <canvas>. */
export function moqRenderSink(mediaPackaging: "cmaf" | "loc"): "video" | "canvas" {
  return mediaPackaging === "loc" ? "canvas" : "video";
}

export type CmafStallAction = "ok" | "hold" | "restart" | "give_up";

/**
 * Frozen-playhead watchdog for CMAF/MSE.
 *
 * Prod `0b1e1ac` / `100826e`: catalog ready, vt=2.97s, ahead=0.53s,
 * then `playhead_frozen_*_buffered_early_join` tore the session down.
 * Reconnects 2/3 and 3/3 came back at vt=0 (catalog/group gone) and
 * never recovered. A GOP-sized buffer at ~3s is a live-edge join
 * waiting for the next fragment — keep the session.
 */
export function classifyCmafPlayheadStall(input: {
  videoTimeSec: number;
  aheadSec: number;
  frozenMs: number;
  earlyWindow: boolean;
  sessionRestarts: number;
  maxRestarts?: number;
  retrying: boolean;
  stallLimitMs: number;
}): CmafStallAction {
  if (input.retrying) {
    return "ok";
  }
  if (input.frozenMs <= input.stallLimitMs) {
    return "ok";
  }
  const maxRestarts = input.maxRestarts ?? 3;
  const buffered = input.aheadSec >= CMAF_BUFFERED_HOLD_SEC;
  const joined = input.videoTimeSec >= CMAF_JOINED_PLAYHEAD_SEC;

  // Buffered hole / live-edge GOP wait. Restarting burns the one-shot
  // catalog and the next subscribe starts at vt=0.
  if (buffered) {
    return "hold";
  }
  // Early-join starvation or a reconnect that wiped MSE: keep-alive
  // (playa REQUEST_UPDATE) beats a session teardown.
  if (input.earlyWindow || !joined) {
    return "hold";
  }
  if (input.sessionRestarts < maxRestarts) {
    return "restart";
  }
  return "give_up";
}

export function isPublisherNotReadyError(code: number): boolean {
  return (
    code === MOQ_ALL_TRACKS_REFUSED ||
    code === MOQ_SUBSCRIPTION_REFUSED ||
    code === MOQ_LOAD_FAILED
  );
}

/** True: leave the WebTransport session up so catalog group 0 can still arrive. */
export function shouldKeepSessionOnSubscribeError(options: {
  firstFrame: boolean;
  code: number;
}): boolean {
  return !options.firstFrame && isPublisherNotReadyError(options.code);
}

export function moqHasRenderedMedia(options: {
  firstFrame?: boolean;
  framesRendered?: number;
  videoTimeSec?: number;
}): boolean {
  return Boolean(
    options.firstFrame ||
      (options.framesRendered ?? 0) > 0 ||
      (options.videoTimeSec ?? 0) > 0.25,
  );
}

export function noMediaTimeoutMs(encodeDurationSec: number): number {
  const durationMs = Math.max(0, encodeDurationSec) * 1000;
  if (durationMs > 0) {
    return Math.max(8_000, Math.min(MOQ_NO_MEDIA_TIMEOUT_MS, Math.round(durationMs * 0.4)));
  }
  return MOQ_NO_MEDIA_TIMEOUT_MS;
}

export function isCaptureOrPublishError(error?: string | null): boolean {
  if (!error) {
    return false;
  }
  const text = error.toLowerCase();
  return (
    text.includes("ffmpeg exited") ||
    text.includes("shared webcam capture") ||
    text.includes("avfoundation") ||
    text.includes("selected framerate") ||
    text.includes("code 251") ||
    text.includes("input/output error") ||
    text.includes("conversion failed") ||
    text.includes("opening input")
  );
}

/** Tester-facing job error — capture failures must not read as a catalog miss. */
export function humanizeJobError(error?: string | null): string | null {
  const raw = (error || "").trim();
  if (!raw) {
    return null;
  }
  if (!isCaptureOrPublishError(raw)) {
    return raw;
  }
  const first = raw.split("\n")[0].replace(/\s+/g, " ").trim();
  const modeMatch =
    raw.match(/supported modes?\s*(?:are\s*)?:?\s*[^\n.]+/i) ||
    raw.match(/1920x1080@\d+fps/i);
  const mode = modeMatch ? modeMatch[0].replace(/^supported modes?\s*(?:are\s*)?:?\s*/i, "").trim() : "";
  if (/framerate|avfoundation|shared webcam/i.test(raw)) {
    return [
      "The camera on this laptop could not start, so nothing was published.",
      mode ? `This device reported: ${mode}.` : first,
      "This is not a player or catalog problem. Use Cloud playout or Browser, or a camera mode the device actually supports.",
    ].join(" ");
  }
  return `The publisher never started (${first}). This is not a player or catalog problem.`;
}

export function playerErrorForFailedJob(options: {
  jobStatus?: string;
  jobError?: string | null;
}): string | null {
  if (options.jobStatus !== "failed") {
    return null;
  }
  return humanizeJobError(options.jobError);
}

export function noMediaFailMessage(options: {
  catalogReady: boolean;
  namespace?: string;
  jobStatus?: string;
  jobError?: string | null;
}): string {
  const jobFail = playerErrorForFailedJob(options);
  if (jobFail) {
    return jobFail;
  }
  if (options.catalogReady) {
    return "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.";
  }
  const ns = (options.namespace || "").trim();
  return ns
    ? `MoQ catalog never loaded on namespace ${ns}. Publisher must be live; a 0x10 subscribe miss is not OK.`
    : "MoQ catalog never loaded. Publisher must be live; a 0x10 subscribe miss is not OK.";
}

export type MoqEndVerdict =
  | { ok: true; status: string; error: null }
  | { ok: false; status: "Failed (see diagnostics)"; error: string };

export function classifyMoqEndVerdict(options: {
  firstFrame?: boolean;
  framesRendered?: number;
  videoTimeSec?: number;
  catalogReady?: boolean;
  encodeDurationSec?: number;
  sessionRestarts?: number;
  lastError?: string | null;
  namespace?: string;
  jobStatus?: string;
  jobError?: string | null;
}): MoqEndVerdict {
  const jobFail = playerErrorForFailedJob(options);
  if (jobFail && !moqHasRenderedMedia(options)) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: jobFail,
    };
  }
  const played = moqHasRenderedMedia(options);
  const duration = options.encodeDurationSec ?? 0;
  const vt = options.videoTimeSec ?? 0;
  const covered = duration > 0 && vt >= duration * 0.8;
  if (played && covered) {
    const restarts = options.sessionRestarts ?? 0;
    return {
      ok: true,
      status:
        restarts > 0
          ? `Playback ended (reconnected ${restarts}× after a freeze)`
          : "Playback OK",
      error: null,
    };
  }
  if (played && !covered) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: `MoQ playback stalled at ${vt.toFixed(1)}s of a ${duration}s encode.`,
    };
  }
  if (options.lastError) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: options.lastError,
    };
  }
  return {
    ok: false,
    status: "Failed (see diagnostics)",
    error: noMediaFailMessage({
      catalogReady: Boolean(options.catalogReady),
      namespace: options.namespace,
      jobStatus: options.jobStatus,
      jobError: options.jobError,
    }),
  };
}
