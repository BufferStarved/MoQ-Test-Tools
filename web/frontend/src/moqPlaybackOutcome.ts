/** Survives MoqPlayer remounts / Strict Mode so end-gate verdicts stay honest. */

export type MoqPlaybackOutcome = {
  catalogReady: boolean;
  firstFrame: boolean;
  ttffMs: number;
  videoTimeSec: number;
};

const outcomes = new Map<string, MoqPlaybackOutcome>();

function emptyOutcome(): MoqPlaybackOutcome {
  return {
    catalogReady: false,
    firstFrame: false,
    ttffMs: 0,
    videoTimeSec: 0,
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
  opts?: { ttffMs?: number; videoTimeSec?: number },
): void {
  if (!jobId) {
    return;
  }
  const current = outcomes.get(jobId) ?? emptyOutcome();
  outcomes.set(jobId, {
    catalogReady: true,
    firstFrame: true,
    ttffMs: Math.max(current.ttffMs, opts?.ttffMs ?? 0),
    videoTimeSec: Math.max(current.videoTimeSec, opts?.videoTimeSec ?? 0),
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
  return outcome.firstFrame || outcome.videoTimeSec > 0.25 || outcome.ttffMs > 0;
}
