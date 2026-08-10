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
 *
 * `stallCount` increments once per wait bracket (HTML truth used by every
 * player). `totalSec` includes any in-progress wait so samples during a
 * freeze are not understated.
 */
export class RebufferTracker {
  private waitingSinceMs = 0;
  private totalMs = 0;
  private stalls = 0;

  /** Call from the element's `waiting` handler (or frozen-playhead detector). */
  beginWait(hasPlayedOnce: boolean): void {
    if (!hasPlayedOnce || this.waitingSinceMs > 0) {
      return;
    }
    this.waitingSinceMs = Date.now();
    this.stalls += 1;
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

  restore(totalMs: number, stallCount: number, resumeWait = false): void {
    this.totalMs = Math.max(0, totalMs);
    this.stalls = Math.max(0, Math.floor(stallCount));
    // Resume an in-flight stall across remount without incrementing stallCount.
    this.waitingSinceMs = resumeWait ? Date.now() : 0;
  }

  reset(): void {
    this.waitingSinceMs = 0;
    this.totalMs = 0;
    this.stalls = 0;
  }

  get stallCount(): number {
    return this.stalls;
  }

  get isWaiting(): boolean {
    return this.waitingSinceMs > 0;
  }

  /** Closed wait time only (ms). */
  get totalMsRaw(): number {
    return this.totalMs;
  }

  /** Closed + in-progress wait (ms) — use when persisting across remounts. */
  get totalMsIncludingOpen(): number {
    let ms = this.totalMs;
    if (this.waitingSinceMs > 0) {
      ms += Date.now() - this.waitingSinceMs;
    }
    return ms;
  }

  get totalSec(): number {
    return Math.round((this.totalMsIncludingOpen / 1000) * 1000) / 1000;
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
 *
 * `minAheadSec` is the caller's trigger threshold — the seek fires once the
 * buffer lead exceeds it (defaults to 2.5× hold). Callers with their own
 * threshold MUST pass it here: MoqPlayer used to gate at hold×2 externally
 * while this helper silently required hold×2.5, so between the two
 * thresholds nothing ever seeked and a 4s target drifted to ~9.5s e2e
 * (webcam run 2026-08-08 23:45).
 */
export function seekNearLiveEdge(
  media: HTMLMediaElement | null | undefined,
  holdBehindSec: number,
  minAheadSec?: number,
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
  const threshold = Math.max(hold + 0.5, minAheadSec ?? hold * 2.5);
  if (ahead < threshold) {
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
