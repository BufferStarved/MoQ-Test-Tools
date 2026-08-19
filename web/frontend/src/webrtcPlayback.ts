/**
 * WHEP end-of-run policy. MoQ has classifyMoqEndVerdict; WebRTC previously
 * cleared the player error when playbackGate flipped to "ended", so a black
 * WHEP tile looked like success (comparison CSV 2026-08-19: 0–1 rendered
 * frames, encode lag 20s+, no UI error).
 */

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

export function classifyWhepEndVerdict(options: {
  framesRendered?: number;
  videoTimeSec?: number;
  lastError?: string | null;
  encodeDurationSec?: number;
}): WhepEndVerdict {
  const played = whepHasRenderedMedia(options);
  const duration = options.encodeDurationSec ?? 0;
  const vt = options.videoTimeSec ?? 0;
  const covered = duration > 0 && vt >= duration * 0.8;
  if (played && covered) {
    return { ok: true, status: "Playback OK", error: null };
  }
  if (played && !covered && duration > 0) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: `WebRTC playback stalled at ${vt.toFixed(1)}s of a ${duration}s encode.`,
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
