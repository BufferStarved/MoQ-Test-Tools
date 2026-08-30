/**
 * WHEP end-of-run policy. MoQ has classifyMoqEndVerdict; WebRTC previously
 * cleared the player error when playbackGate flipped to "ended", so a black
 * WHEP tile looked like success (comparison CSV 2026-08-19: 0–1 rendered
 * frames, encode lag 20s+, no UI error).
 */

import { isGracefulMoqEncodeOver } from "./playbackEos.ts";
import { playbackCoveredEncode, stallAgainstEncodeMessage } from "./playbackEndVerdict.ts";

export function whepHasRenderedMedia(options: {
  framesRendered?: number;
}): boolean {
  // One decoded frame is not playback. MediaStream currentTime can also
  // advance on a frozen track — require a handful of paints.
  return (options.framesRendered ?? 0) >= 8;
}

export type WhepEndVerdict =
  | { ok: true; status: string; error: null }
  | { ok: false; status: "Failed (see diagnostics)"; error: string };

export function noWhepMediaFailMessage(options: { lastError?: string | null }): string {
  const last = (options.lastError || "").trim();
  if (last) {
    return last;
  }
  return "WebRTC/WHEP produced no video frames. Encode-only success is a player or WHIP failure.";
}

/** WHEP MediaStream <video> usually has empty buffered ranges. Plot the
 * RTC jitter buffer (jitterBufferDelay / emittedCount) instead. */
export function whepPlaybackBufferSec(options: {
  jitterBufferMs?: number;
  htmlBufferedAheadSec?: number;
}): number {
  const fromJitter = Math.max(0, options.jitterBufferMs ?? 0) / 1000;
  if (fromJitter > 0) {
    return fromJitter;
  }
  return Math.max(0, options.htmlBufferedAheadSec ?? 0);
}

export function classifyWhepEndVerdict(options: {
  framesRendered?: number;
  videoTimeSec?: number;
  lastError?: string | null;
  encodeDurationSec?: number;
  encodeElapsedSec?: number;
  runStopped?: boolean;
  jobStatus?: string;
}): WhepEndVerdict {
  const played = whepHasRenderedMedia(options);
  const covered = playbackCoveredEncode(options);
  if (played && covered) {
    return { ok: true, status: "Playback OK", error: null };
  }
  // Stop / encode-over after paint is not a stall. WHEP currentTime lags
  // the encode (live glass + player detach on Stop); leftover planned
  // duration_sec is the 24.7s-of-36s lie. A real freeze is playhead stuck
  // far behind the encode that actually ran.
  if (
    played &&
    isGracefulMoqEncodeOver({
      playedOk: true,
      jobStatus: options.jobStatus,
      runStopped: options.runStopped,
    })
  ) {
    const elapsed = options.encodeElapsedSec ?? 0;
    const vt = options.videoTimeSec ?? 0;
    if (elapsed > 0 && vt < elapsed * 0.8 && elapsed - vt >= 15) {
      return {
        ok: false,
        status: "Failed (see diagnostics)",
        error: stallAgainstEncodeMessage({
          protocolLabel: "WebRTC",
          videoTimeSec: options.videoTimeSec,
          encodeDurationSec: options.encodeDurationSec,
          encodeElapsedSec: options.encodeElapsedSec,
          runStopped: options.runStopped,
        }),
      };
    }
    return { ok: true, status: "Playback OK", error: null };
  }
  if (played && !covered) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: stallAgainstEncodeMessage({
        protocolLabel: "WebRTC",
        videoTimeSec: options.videoTimeSec,
        encodeDurationSec: options.encodeDurationSec,
        encodeElapsedSec: options.encodeElapsedSec,
        runStopped: options.runStopped,
      }),
    };
  }
  if (played) {
    return { ok: true, status: "Playback OK", error: null };
  }
  return {
    ok: false,
    status: "Failed (see diagnostics)",
    error: noWhepMediaFailMessage({ lastError: options.lastError }),
  };
}
