const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

const FLUSH_INTERVAL_MS = 5_000;
const MAX_PENDING = 400;

/**
 * Batches player diagnostic lines (pushDiag) and persists them to the API so
 * any run can be post-mortemed from the server alone — no more asking testers
 * to copy the diagnostics panel after a bad run.
 */
export function createPlaybackDiagReporter(jobId: string | undefined, engine: string) {
  let pending: string[] = [];
  let timer: number | null = null;
  let stopped = false;

  async function flush(useBeacon = false): Promise<void> {
    if (!jobId || pending.length === 0) {
      return;
    }
    const lines = pending;
    pending = [];
    const url = `${API_BASE}/uploads/${jobId}/playback-diag`;
    const body = JSON.stringify({ engine, lines });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        return;
      }
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: useBeacon,
      });
    } catch {
      // Diagnostics are best-effort; never let them affect playback.
    }
  }

  function schedule(): void {
    if (timer !== null || stopped) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
  }

  return {
    push(line: string): void {
      if (stopped || !jobId) {
        return;
      }
      if (pending.length >= MAX_PENDING) {
        pending.shift();
      }
      pending.push(line);
      schedule();
    },
    /** Final flush on unmount/teardown; uses sendBeacon so it survives navigation. */
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      void flush(true);
    },
  };
}
