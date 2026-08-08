/**
 * Browser ↔ API-server clock-skew probe.
 *
 * Every latency anchor in this app (job `started_at_epoch`,
 * `first_sample_at_epoch`, and the encode anchor derived from them) is
 * stamped with the API server's wall clock, while the players compare
 * against `Date.now()`. A laptop clock a second off NTP silently shifts
 * every wall−playhead latency estimate by that amount — in both
 * directions, differently per machine — which is exactly the kind of
 * cross-protocol inconsistency the unified formula is meant to eliminate.
 *
 * NTP-style estimate: for each probe, offset ≈ serverEpoch − (t0+t1)/2.
 * The probe with the smallest round-trip time has the tightest error
 * bound (±rtt/2), so its offset wins.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const PROBE_COUNT = 5;
/** Ignore probes slower than this — a congested request bounds nothing. */
const MAX_USABLE_RTT_MS = 2_000;
/** Re-probe cadence; crystal drift over a benchmark session is negligible. */
const REPROBE_INTERVAL_MS = 10 * 60 * 1000;

let skewMs = 0;
let started = false;

/**
 * Current best estimate of (server clock − browser clock) in ms.
 * 0 until the first probe completes (i.e. gracefully degrades to the
 * old uncorrected behavior).
 */
export function clockSkewMs(): number {
  return skewMs;
}

/** `Date.now()` expressed on the API server's clock. */
export function serverNowMs(): number {
  return Date.now() + skewMs;
}

async function probeOnce(): Promise<{ offsetMs: number; rttMs: number } | null> {
  const t0 = Date.now();
  try {
    const response = await fetch(`${API_BASE}/time`, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { epoch?: number };
    const t1 = Date.now();
    if (!body.epoch || body.epoch <= 0) {
      return null;
    }
    const rttMs = t1 - t0;
    return { offsetMs: body.epoch * 1000 - (t0 + t1) / 2, rttMs };
  } catch {
    return null;
  }
}

async function runProbes(): Promise<void> {
  let best: { offsetMs: number; rttMs: number } | null = null;
  for (let i = 0; i < PROBE_COUNT; i += 1) {
    const probe = await probeOnce();
    if (probe && probe.rttMs <= MAX_USABLE_RTT_MS && (!best || probe.rttMs < best.rttMs)) {
      best = probe;
    }
  }
  if (best) {
    skewMs = Math.round(best.offsetMs);
  }
}

/**
 * Kick off the background probe loop (idempotent). Call once at app
 * startup; players read `clockSkewMs()` synchronously afterwards.
 */
export function startClockSkewProbe(): void {
  if (started) {
    return;
  }
  started = true;
  void runProbes();
  window.setInterval(() => {
    void runProbes();
  }, REPROBE_INTERVAL_MS);
}
