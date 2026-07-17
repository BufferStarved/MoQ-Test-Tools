/** Seconds of media buffered ahead of the playhead (0 if none / unknown). */
export function bufferedAheadSec(media: HTMLMediaElement | null | undefined): number {
  if (!media) {
    return 0;
  }
  const { buffered, currentTime } = media;
  if (!buffered || buffered.length === 0) {
    return 0;
  }
  for (let i = 0; i < buffered.length; i += 1) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (currentTime >= start - 0.05 && currentTime <= end + 0.05) {
      return Math.max(0, end - currentTime);
    }
  }
  // Playhead outside ranges — report the latest range ahead of currentTime if any.
  for (let i = buffered.length - 1; i >= 0; i -= 1) {
    const end = buffered.end(i);
    if (end > currentTime) {
      return Math.max(0, end - currentTime);
    }
  }
  return 0;
}

/**
 * Tracks cumulative rebuffer time from `waiting` → `playing` brackets on a
 * native `<video>` element. Ignores stalls before first playback (ttff==0)
 * so initial join/pre-roll buffering isn't counted as a rebuffer.
 */
export class RebufferTracker {
  private waitingSinceMs = 0;
  private totalMs = 0;

  /** Call from the element's `waiting` handler. */
  beginWait(hasPlayedOnce: boolean): void {
    if (!hasPlayedOnce || this.waitingSinceMs > 0) {
      return;
    }
    this.waitingSinceMs = Date.now();
  }

  /** Call from the element's `playing` (or `canplay`) handler. */
  endWait(): void {
    if (this.waitingSinceMs <= 0) {
      return;
    }
    this.totalMs += Date.now() - this.waitingSinceMs;
    this.waitingSinceMs = 0;
  }

  /** Directly add a known stall duration (e.g. from a player's own stall event). */
  addSec(durationSec: number): void {
    if (Number.isFinite(durationSec) && durationSec > 0) {
      this.totalMs += durationSec * 1000;
    }
  }

  reset(): void {
    this.waitingSinceMs = 0;
    this.totalMs = 0;
  }

  get totalSec(): number {
    return Math.round((this.totalMs / 1000) * 1000) / 1000;
  }
}

/** End of the latest buffered range, or null. */
export function bufferedEndSec(media: HTMLMediaElement | null | undefined): number | null {
  if (!media?.buffered || media.buffered.length === 0) {
    return null;
  }
  return media.buffered.end(media.buffered.length - 1);
}

/**
 * Seek near the live edge, keeping `holdBehindSec` of buffer.
 * Returns true when a seek was issued.
 */
export function seekNearLiveEdge(
  media: HTMLMediaElement | null | undefined,
  holdBehindSec: number,
): boolean {
  if (!media || media.readyState < 2) {
    return false;
  }
  const end = bufferedEndSec(media);
  if (end == null) {
    return false;
  }
  const hold = Math.max(0.15, holdBehindSec);
  const ahead = end - media.currentTime;
  // Only jump when we're holding clearly more than the target live buffer.
  if (ahead < hold * 2.5) {
    return false;
  }
  const target = Math.max(0, end - hold);
  if (Math.abs(media.currentTime - target) < 0.2) {
    return false;
  }
  try {
    media.currentTime = target;
    return true;
  } catch {
    return false;
  }
}
