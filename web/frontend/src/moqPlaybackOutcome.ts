/** Survives MoqPlayer remounts / Strict Mode so end-gate verdicts stay honest. */

export type MoqPlaybackOutcome = {
  catalogReady: boolean;
  firstFrame: boolean;
  ttffMs: number;
  videoTimeSec: number;
  framesRendered: number;
};

const outcomes = new Map<string, MoqPlaybackOutcome>();

function emptyOutcome(): MoqPlaybackOutcome {
  return {
    catalogReady: false,
    firstFrame: false,
    ttffMs: 0,
    videoTimeSec: 0,
    framesRendered: 0,
  };
}

export function resetMoqPlaybackOutcome(jobId: string | undefined): void {
  if (!jobId) {
    return;
  }
  outcomes.set(jobId, emptyOutcome());
}

export function markMoqCatalogReady(jobId: string | undefined): void {
  if (!jobId) {
    return;
  }
  const current = outcomes.get(jobId) ?? emptyOutcome();
  outcomes.set(jobId, { ...current, catalogReady: true });
}

export function markMoqFirstFrame(
  jobId: string | undefined,
  opts?: { ttffMs?: number; videoTimeSec?: number; framesRendered?: number },
): void {
  if (!jobId) {
    return;
  }
  const current = outcomes.get(jobId) ?? emptyOutcome();
  const videoTimeSec = Math.max(current.videoTimeSec, opts?.videoTimeSec ?? 0);
  const framesRendered = Math.max(current.framesRendered, opts?.framesRendered ?? 0);
  outcomes.set(jobId, {
    catalogReady: true,
    firstFrame: current.firstFrame || videoTimeSec > 0.25 || framesRendered > 0,
    ttffMs: Math.max(current.ttffMs, opts?.ttffMs ?? 0),
    videoTimeSec,
    framesRendered,
  });
}

export function getMoqPlaybackOutcome(jobId: string | undefined): MoqPlaybackOutcome | null {
  if (!jobId) {
    return null;
  }
  return outcomes.get(jobId) ?? null;
}

export function moqPlaybackSucceeded(jobId: string | undefined): boolean {
  const outcome = getMoqPlaybackOutcome(jobId);
  if (!outcome) {
    return false;
  }
  // ttffMs alone is not playback — playa / path-delay can stamp a number
  // while frames_rendered and video_time stay 0 (BBB CMAF 2026-08-18).
  return outcome.firstFrame || outcome.videoTimeSec > 0.25 || outcome.framesRendered > 0;
}
