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

export function noMediaFailMessage(options: {
  catalogReady: boolean;
  namespace?: string;
}): string {
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
}): MoqEndVerdict {
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
    }),
  };
}
