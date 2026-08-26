/**
 * Zixi Fast HLS playlist helpers shared by HlsPlayer and unit checks.
 *
 * Zixi often advertises TARGETDURATION=2 (or hundreds of seconds after a
 * large -output_ts_offset) while EXTINF is the real GOP-sized chunk. Live
 * sync and stale-fragment detection must trust the media, not the banner.
 */

export const HLS_TARGET_DURATION_CAP_SEC = 6;
export const STALE_FRAG_FAIL_AFTER = 12;
/** Same-URL reloads after the first GOP has painted but the playhead is frozen. */
export const STALE_FRAG_FROZEN_AFTER = 6;

export function playlistDepth(body: string): number {
  return body.split("\n").filter((row) => {
    const line = row.trim();
    return Boolean(line) && !line.startsWith("#");
  }).length;
}

/** hls.js segment-count sync. A 1-deep Fast HLS pack must not ask for two. */
export function hlsLiveSyncDurationCount(depth: number, requestedCount = 2): number {
  return depth <= 1 ? 1 : Math.max(1, requestedCount);
}

export function playlistExtinfMaxSec(body: string): number | null {
  let max = 0;
  for (const match of body.matchAll(/#EXTINF:(\d+(?:\.\d+)?)/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) {
      max = value;
    }
  }
  return max > 0 ? max : null;
}

export function playlistTargetDurationSec(body: string): number {
  const match = body.match(/#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/);
  const declared = match ? Number(match[1]) : NaN;
  const extinf = playlistExtinfMaxSec(body);
  if (extinf != null) {
    const extinfCeil = Math.max(1, Math.ceil(extinf));
    const declaredAbsurd =
      !Number.isFinite(declared) || declared > HLS_TARGET_DURATION_CAP_SEC * 2;
    // Prefer real segment duration when TARGETDURATION is missing, ballooned
    // (offset artifact), or disagrees with EXTINF (2s banner vs 3s GOP).
    if (declaredAbsurd || Math.abs(declared - extinf) >= 0.75) {
      return Math.min(HLS_TARGET_DURATION_CAP_SEC, extinfCeil);
    }
  }
  if (Number.isFinite(declared) && declared > 0) {
    return Math.max(1, Math.min(HLS_TARGET_DURATION_CAP_SEC, declared));
  }
  return 2;
}

/** Live sync in seconds, never below one TARGETDURATION on non-LL Zixi packs. */
export function hlsSyncDurationForPlaylist(body: string, requestedSec: number): number {
  const depth = playlistDepth(body);
  const targetDuration = playlistTargetDurationSec(body);
  const requested = Math.max(targetDuration, Math.min(20, requestedSec || 4));
  if (depth <= 1) {
    return targetDuration;
  }
  const maxHold = Math.max(targetDuration, (depth - 1) * targetDuration);
  return Math.max(targetDuration, Math.min(requested, maxHold));
}

/**
 * True when hls.js is looping one URL and the playhead is not making progress.
 *
 * A healthy 1-deep Zixi playlist reloads the current chunk until the next
 * IDR — that must not kill a playing player. Fail when:
 *   - the same URL is the only one seen AND the playhead never moved, or
 *   - the first GOP painted and the playhead then froze on that same URL
 *     (2026-08-26 Zixi RTMP: rendered stuck at ~35 / 2.0s).
 */
export function isStaleHlsFragmentLoop(args: {
  uniqueUrlCount: number;
  sameUrlLoads: number;
  videoAdvanced: boolean;
  playheadFrozen?: boolean;
  threshold?: number;
}): boolean {
  if (args.uniqueUrlCount !== 1) {
    return false;
  }
  if (args.playheadFrozen) {
    const frozenAfter = args.threshold ?? STALE_FRAG_FROZEN_AFTER;
    return args.sameUrlLoads >= frozenAfter;
  }
  if (args.videoAdvanced) {
    return false;
  }
  const threshold = args.threshold ?? STALE_FRAG_FAIL_AFTER;
  return args.sameUrlLoads >= threshold;
}
