/**
 * Operator "Go Live" — drain the playhead to the protocol's safe minimum.
 *
 * Auto-chase after first paint is still the default. This is an optional
 * hitch-ok jump when the operator wants the glass now. It must refuse a
 * buffer hole or a frozen playhead: that was the 7s MoQ seek freeze.
 */

export type GoLiveEngine = "ll-hls" | "hls" | "mpegts" | "dash" | "moq-cmaf";

export type GoLiveResult =
  | { ok: true; fromSec: number; toSec: number; aheadSec: number }
  | { ok: false; reason: "frozen" | "no_buffer" | "hole" | "already_live" };

/** Healthy CMAF / LL / HTTP-TS hold — one-frame-class, not an HLS window. */
export const GO_LIVE_HOLD_LOW_SEC = 0.4;
/** Zixi Fast HLS cannot chase below one TARGETDURATION. */
export const GO_LIVE_HOLD_HLS_FLOOR_SEC = 1;

/** Hide on WHEP / LOC / upload-only. Present on CMAF, HLS, MPEG-TS, DASH. */
export function goLiveButtonVisible(options: {
  engine?: string | null;
  packaging?: "cmaf" | "loc" | string | null;
  testScope?: string | null;
}): boolean {
  if ((options.testScope ?? "").trim().toLowerCase() === "upload") {
    return false;
  }
  const engine = (options.engine ?? "").trim().toLowerCase();
  const packaging = (options.packaging ?? "").trim().toLowerCase();
  if (engine === "whep" || engine === "webrtc") {
    return false;
  }
  if (packaging === "loc" || engine === "moq-loc") {
    return false;
  }
  if (engine === "moq" || engine === "moq-cmaf" || engine === "playa") {
    return true;
  }
  return engine === "ll-hls" || engine === "hls" || engine === "mpegts" || engine === "dash";
}

export function goLiveHoldSec(
  engine: GoLiveEngine,
  targetDurationSec?: number,
): number {
  if (engine === "hls") {
    return Math.max(GO_LIVE_HOLD_HLS_FLOOR_SEC, targetDurationSec ?? 2);
  }
  return GO_LIVE_HOLD_LOW_SEC;
}

export function bufferedRangeContaining(
  media: HTMLMediaElement,
  timeSec: number,
): { start: number; end: number } | null {
  const { buffered } = media;
  if (!buffered || buffered.length === 0) {
    return null;
  }
  for (let i = 0; i < buffered.length; i += 1) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (timeSec >= start - 0.05 && timeSec <= end + 0.05) {
      return { start, end };
    }
  }
  return null;
}

/**
 * Seek to live inside the current contiguous range only.
 * `preferTime` (hls.js liveSyncPosition) is used when it sits in that range.
 */
export function seekGoLive(
  media: HTMLMediaElement | null | undefined,
  holdBehindSec: number,
  preferTime?: number | null,
): GoLiveResult {
  if (!media || media.readyState < 2) {
    return { ok: false, reason: "frozen" };
  }
  const range = bufferedRangeContaining(media, media.currentTime);
  if (!range) {
    return { ok: false, reason: "no_buffer" };
  }
  const { buffered } = media;
  const latestEnd = buffered.end(buffered.length - 1);
  // A later range means a hole between the playhead and the live edge.
  if (latestEnd > range.end + 0.15) {
    return { ok: false, reason: "hole" };
  }
  const hold = Math.max(0.15, holdBehindSec);
  let target = Math.max(range.start, range.end - hold);
  if (
    preferTime != null &&
    Number.isFinite(preferTime) &&
    preferTime >= range.start &&
    preferTime <= range.end
  ) {
    target = Math.max(range.start, Math.min(preferTime, range.end - 0.05));
  }
  const ahead = range.end - media.currentTime;
  if (Math.abs(media.currentTime - target) < 0.12) {
    return { ok: false, reason: "already_live" };
  }
  const fromSec = media.currentTime;
  try {
    media.currentTime = target;
  } catch {
    return { ok: false, reason: "frozen" };
  }
  return { ok: true, fromSec, toSec: target, aheadSec: ahead };
}

export function formatGoLiveDiag(
  result: GoLiveResult,
  elapsedSec: number,
  e2eMs: number | undefined,
): string {
  const e2e = e2eMs != null && Number.isFinite(e2eMs) ? Math.round(e2eMs) : 0;
  if (result.ok) {
    return (
      `go_live_at_sec=${elapsedSec} e2e=${e2e} ` +
      `from=${result.fromSec.toFixed(2)}s to=${result.toSec.toFixed(2)}s ` +
      `ahead=${result.aheadSec.toFixed(2)}s`
    );
  }
  return `go_live_at_sec=${elapsedSec} e2e=${e2e} refused=${result.reason}`;
}

export function latchGoLive(
  current: { atSec: number; e2eMs: number },
  elapsedSec: number,
  e2eMs: number | undefined,
): { atSec: number; e2eMs: number } {
  if (current.atSec > 0) {
    return current;
  }
  return {
    atSec: Math.max(0, elapsedSec),
    e2eMs: e2eMs != null && Number.isFinite(e2eMs) && e2eMs > 0 ? Math.round(e2eMs) : 0,
  };
}
