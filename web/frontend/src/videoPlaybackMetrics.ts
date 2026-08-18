import { RebufferTracker } from "./playbackBuffer";

/**
 * Cross-player HTML media metrics. MoQ previously depended on playa `stall`
 * events (easy to miss); HLS used waiting→playing. Every engine now uses
 * this so rebuffer/stall/frames mean the same thing at the glass.
 */

export interface VideoFrameStats {
  framesRendered: number;
  framesDropped: number;
}

/** Prefer the browser's decoded-frame counters when available. */
export function readVideoFrameStats(video: HTMLVideoElement | null | undefined): VideoFrameStats {
  if (!video) {
    return { framesRendered: 0, framesDropped: 0 };
  }
  const quality = video.getVideoPlaybackQuality?.();
  if (quality) {
    return {
      framesRendered: quality.totalVideoFrames || 0,
      framesDropped: quality.droppedVideoFrames || 0,
    };
  }
  const webkitDropped = (video as HTMLVideoElement & { webkitDroppedFrameCount?: number })
    .webkitDroppedFrameCount;
  return {
    framesRendered: 0,
    framesDropped: typeof webkitDropped === "number" ? webkitDropped : 0,
  };
}

/**
 * Wire standard rebuffer + stall counting onto a `<video>`.
 * Also runs a frozen-playhead detector for engines that stall without firing
 * `waiting` (observed on MoQ MSE wedges).
 */
export function attachHtmlPlaybackMonitors(
  video: HTMLVideoElement,
  options: {
    rebuffer: RebufferTracker;
    hasPlayedOnce: () => boolean;
    onStallBegin?: () => void;
    /** Poll interval for frozen-playhead detection. */
    frozenPollMs?: number;
    /** Playhead must be stuck this long with buffer ahead to count as a stall. */
    frozenStuckMs?: number;
  },
): () => void {
  const {
    rebuffer,
    hasPlayedOnce,
    onStallBegin,
    frozenPollMs = 250,
    // Long enough to ignore decoder micro-hitches; short enough to catch
    // visible freezes. 450ms was false-triggering on Fast HLS (10 "stalls"
    // that were really sub-frame scheduling noise).
    frozenStuckMs = 800,
  } = options;

  let lastVt = video.currentTime;
  let stuckSinceMs = 0;
  /** True when the current wait was opened by the frozen detector (no `playing`). */
  let frozenOwnedWait = false;

  const onWaiting = () => {
    const before = rebuffer.stallCount;
    rebuffer.beginWait(hasPlayedOnce());
    if (rebuffer.stallCount > before) {
      frozenOwnedWait = false;
      onStallBegin?.();
    }
  };
  const onPlaying = () => {
    frozenOwnedWait = false;
    rebuffer.endWait();
  };

  video.addEventListener("waiting", onWaiting);
  video.addEventListener("playing", onPlaying);
  const frozenTimer = window.setInterval(() => {
    if (!hasPlayedOnce() || video.paused || video.ended || video.seeking) {
      lastVt = video.currentTime;
      stuckSinceMs = 0;
      return;
    }
    const vt = video.currentTime;
    // Require a real jump (>100ms) before auto-closing a frozen-owned wait.
    // Micro-advances (~1 frame) used to endWait early and under-report
    // rebuffer seconds while stall counts still matched (SRT: 2 stalls /
    // 0.13s reported vs 1.09s glass).
    const advanced = vt > lastVt + 0.1;
    if (advanced) {
      lastVt = vt;
      stuckSinceMs = 0;
      if (frozenOwnedWait) {
        rebuffer.endWait();
        frozenOwnedWait = false;
      }
      return;
    }
    const bufferedAhead =
      video.buffered.length > 0
        ? Math.max(0, video.buffered.end(video.buffered.length - 1) - vt)
        : 0;
    // Only count a freeze when media is clearly queued ahead of a stuck
    // playhead (MoQ MSE gap / wedge). Empty-buffer live-edge starvation is
    // covered by the native `waiting` event — do not double-count it here.
    if (bufferedAhead < 0.35 || video.readyState >= 3) {
      if (bufferedAhead < 0.75) {
        stuckSinceMs = 0;
        return;
      }
    }
    if (stuckSinceMs <= 0) {
      stuckSinceMs = Date.now();
      return;
    }
    if (Date.now() - stuckSinceMs >= frozenStuckMs) {
      const before = rebuffer.stallCount;
      rebuffer.beginWait(true);
      if (rebuffer.stallCount > before) {
        frozenOwnedWait = true;
        onStallBegin?.();
      }
    }
  }, frozenPollMs);

  return () => {
    video.removeEventListener("waiting", onWaiting);
    video.removeEventListener("playing", onPlaying);
    window.clearInterval(frozenTimer);
    rebuffer.endWait();
  };
}

/**
 * Stall detector for canvas / LOC players where `<video>.currentTime` does
 * not advance. Counts a freeze when decoded-frame counters stop increasing.
 */
export function attachFrameStallMonitor(options: {
  rebuffer: RebufferTracker;
  getFrames: () => number;
  hasPlayedOnce: () => boolean;
  frozenPollMs?: number;
  frozenStuckMs?: number;
}): () => void {
  const {
    rebuffer,
    getFrames,
    hasPlayedOnce,
    frozenPollMs = 250,
    frozenStuckMs = 800,
  } = options;
  let lastFrames = getFrames();
  let stuckSinceMs = 0;
  const timer = window.setInterval(() => {
    if (!hasPlayedOnce()) {
      lastFrames = getFrames();
      stuckSinceMs = 0;
      return;
    }
    const frames = getFrames();
    if (frames > lastFrames) {
      lastFrames = frames;
      stuckSinceMs = 0;
      rebuffer.endWait();
      return;
    }
    if (stuckSinceMs <= 0) {
      stuckSinceMs = Date.now();
      return;
    }
    if (Date.now() - stuckSinceMs >= frozenStuckMs) {
      rebuffer.beginWait(true);
    }
  }, frozenPollMs);
  return () => {
    window.clearInterval(timer);
    rebuffer.endWait();
  };
}

/** Per-job cumulative rebuffer so player remounts don't wipe stall history. */
const jobRebufferAccum = new Map<
  string,
  { totalMs: number; stallCount: number; wasWaiting: boolean }
>();

export function loadJobRebuffer(jobId: string | undefined, tracker: RebufferTracker): void {
  if (!jobId) {
    return;
  }
  const saved = jobRebufferAccum.get(jobId);
  if (saved) {
    // totalMs already includes any open wait folded at persist time; resume
    // the wait clock without bumping stallCount when the freeze continued.
    tracker.restore(saved.totalMs, saved.stallCount, saved.wasWaiting);
  }
}

export function persistJobRebuffer(jobId: string | undefined, tracker: RebufferTracker): void {
  if (!jobId) {
    return;
  }
  // Fold the open bracket into totalMs and remember we were waiting so remount
  // can resume without dropping seconds (RTMP Fast HLS remounts mid-stall).
  jobRebufferAccum.set(jobId, {
    totalMs: tracker.totalMsIncludingOpen,
    stallCount: tracker.stallCount,
    wasWaiting: tracker.isWaiting,
  });
}

export function clearJobRebuffer(jobId: string | undefined): void {
  if (jobId) {
    jobRebufferAccum.delete(jobId);
  }
}
