/**
 * Player-side startup phases, sourced from the browser's own instruments.
 *
 * Mirror of the player half of `src/startup_budget.py`: four durations —
 * `player_request`, `manifest`, `first_media`, `first_paint` — that reconcile
 * against the measured `playback_ttff_ms`. Everything here obeys the same
 * honesty register as `latencyBudget.ts`:
 *
 * **A phase with no instrument is null, never 0.** `0` means "measured, and it
 * was inside the measurement resolution". A phase whose bounding milestones
 * were not both observed is `null`, which downstream reports as *unmeasured*
 * and is why the residual is large. Substituting 0 anywhere in this file would
 * turn "we cannot see this" into "this was free", which is the exact failure
 * the startup family exists to prevent.
 *
 * **Cross-origin opacity is the main risk in this stage.** Resource Timing
 * hands back an entry for a cross-origin request whether or not the server
 * sent `Timing-Allow-Origin`, and without that header every interior mark
 * (`domainLookup*`, `connect*`, `secureConnectionStart`, `requestStart`,
 * `responseStart`) is reported as **0** while `fetchStart`/`responseEnd` stay
 * real. Read naively that yields `requestMs = 0` and `manifestMs = responseEnd`
 * — a confident "DNS + connect + TLS took no time at all" on exactly the legs
 * where it took longest. {@link isOpaqueResourceTiming} detects that shape and
 * the whole entry collapses to null.
 *
 * Most media here is fetched through the app's own `/api/playback/fetch`
 * proxy, so entries are usually same-origin and fully visible; direct
 * (unproxied) URLs to a relay or packager host are the opaque case.
 */

/**
 * The Resource Timing marks this module reads. A structural subset of
 * `PerformanceResourceTiming` so the formulas can be unit-tested against plain
 * objects without a browser.
 */
export interface ResourceTimingMarks {
  readonly name: string;
  readonly fetchStart: number;
  readonly domainLookupStart: number;
  readonly domainLookupEnd: number;
  readonly connectStart: number;
  readonly connectEnd: number;
  readonly secureConnectionStart: number;
  readonly requestStart: number;
  readonly responseStart: number;
  readonly responseEnd: number;
}

/** One request's contribution to the startup chain. */
export interface StartupResourceTiming {
  /** `requestStart - fetchStart`: DNS + connect + TLS before a byte was sent. */
  readonly requestMs: number | null;
  /** `responseEnd - requestStart`: request sent → body fully received. */
  readonly manifestMs: number | null;
  /** Wall-clock (epoch ms) the request actually went out. */
  readonly requestSentAtMs: number | null;
  /**
   * Wall-clock (epoch ms) the first response byte arrived. The only milestone
   * a never-ending response has: a raw MPEG-TS pull streams for the whole run,
   * so its `responseEnd` stays 0 while `responseStart` is the instant media
   * began.
   */
  readonly responseStartAtMs: number | null;
  /** Wall-clock (epoch ms) the body finished arriving. */
  readonly responseEndAtMs: number | null;
  /** Sub-marks, for the tooltip that explains a long `requestMs`. */
  readonly domainLookupMs: number | null;
  readonly connectMs: number | null;
  readonly tlsMs: number | null;
  /** True when the entry exists but its interior marks are cross-origin zeros. */
  readonly opaque: boolean;
}

const NO_TIMING: StartupResourceTiming = {
  requestMs: null,
  manifestMs: null,
  requestSentAtMs: null,
  responseStartAtMs: null,
  responseEndAtMs: null,
  domainLookupMs: null,
  connectMs: null,
  tlsMs: null,
  opaque: false,
};

/**
 * Same ceiling as `startup_budget._PHASE_MAX_MS`. Above it the number is a
 * clock artifact, and it is dropped rather than clamped — a clamped artifact
 * charts exactly like a real 120s phase.
 */
const PHASE_MAX_MS = 120_000;

/** Plausible non-negative milliseconds, or null. Zero itself survives. */
function cleanPhaseMs(value: number): number | null {
  if (!Number.isFinite(value) || value < 0 || value > PHASE_MAX_MS) {
    return null;
  }
  return Math.round(value * 10) / 10;
}

/** A duration between two marks, measured only when both are present. */
function markSpan(start: number, end: number): number | null {
  if (!(start > 0) || !(end > 0) || end < start) {
    return null;
  }
  return cleanPhaseMs(end - start);
}

/**
 * Whether an entry's interior marks were zeroed by the same-origin policy.
 *
 * A cross-origin response without `Timing-Allow-Origin` still reports
 * `fetchStart` and `responseEnd`, so `responseEnd > 0` with `requestStart === 0`
 * cannot be a real request — nothing can finish before it starts. That shape is
 * opacity, not a 0 ms connect.
 */
export function isOpaqueResourceTiming(entry: ResourceTimingMarks): boolean {
  return entry.requestStart === 0 && entry.responseEnd > 0;
}

/**
 * Read the startup marks off one Resource Timing entry.
 *
 * Returns all-null for an opaque entry rather than the visible-marks subset:
 * `responseEnd - fetchStart` on an opaque entry is the whole request, and
 * reporting it as `manifestMs` would silently absorb DNS/connect/TLS into the
 * manifest phase — misattribution rather than a missing measurement.
 */
export function readResourceTiming(
  entry: ResourceTimingMarks | null | undefined,
  timeOriginMs: number,
): StartupResourceTiming {
  if (!entry || isOpaqueResourceTiming(entry)) {
    return entry ? { ...NO_TIMING, opaque: true } : NO_TIMING;
  }
  const requestMs = markSpan(entry.fetchStart, entry.requestStart);
  const manifestMs = markSpan(entry.requestStart, entry.responseEnd);
  return {
    requestMs,
    manifestMs,
    requestSentAtMs: entry.requestStart > 0 ? timeOriginMs + entry.requestStart : null,
    responseStartAtMs: entry.responseStart > 0 ? timeOriginMs + entry.responseStart : null,
    responseEndAtMs: entry.responseEnd > 0 ? timeOriginMs + entry.responseEnd : null,
    domainLookupMs: markSpan(entry.domainLookupStart, entry.domainLookupEnd),
    connectMs: markSpan(entry.connectStart, entry.connectEnd),
    // secureConnectionStart is 0 on plain HTTP (no TLS to measure) and on
    // browsers that do not expose it, which is a missing mark either way.
    tlsMs: markSpan(entry.secureConnectionStart, entry.connectEnd),
    opaque: false,
  };
}

/**
 * True when a Resource Timing entry name refers to `target`.
 *
 * Media is usually fetched through `/api/playback/fetch?url=<encoded>`, so the
 * target appears percent-encoded inside the entry name; direct fetches carry it
 * verbatim. Both are matched, and a decode failure falls back to the raw name.
 */
export function resourceTimingNameMatches(name: string, target: string): boolean {
  if (!name || !target) {
    return false;
  }
  if (name.includes(target)) {
    return true;
  }
  if (name.includes(encodeURIComponent(target))) {
    return true;
  }
  try {
    return decodeURIComponent(name).includes(target);
  } catch {
    return false;
  }
}

/**
 * The startup marks for the first request to `target`, or all-null.
 *
 * Deliberately the *first* match. DNS, connect and TLS happen once; every
 * later request on the same URL reuses the warm connection and reports those
 * marks as a genuine 0, so picking the newest entry would report "no connect
 * cost" for a join that spent seconds establishing one. The resource buffer is
 * finite (~250 entries by default) and can evict the join request on a long
 * run — an evicted entry is absent, which is null, not zero.
 */
export function findStartupResourceTiming(
  target: string,
  entries?: readonly ResourceTimingMarks[],
  timeOriginMs?: number,
): StartupResourceTiming {
  const pool = entries ?? readResourceEntries();
  if (!pool) {
    return NO_TIMING;
  }
  const match = pool.find((entry) => resourceTimingNameMatches(entry.name, target));
  return readResourceTiming(match, timeOriginMs ?? readTimeOrigin());
}

function readResourceEntries(): readonly ResourceTimingMarks[] | null {
  if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
    return null;
  }
  try {
    return performance.getEntriesByType("resource") as unknown as readonly ResourceTimingMarks[];
  } catch {
    return null;
  }
}

function readTimeOrigin(): number {
  if (typeof performance === "undefined") {
    return 0;
  }
  const origin = performance.timeOrigin;
  return Number.isFinite(origin) && origin > 0 ? origin : Date.now() - performance.now();
}

// ---------------------------------------------------------------------------
// Phase chain
// ---------------------------------------------------------------------------

/** The four player-chain columns, as the CSV names them. */
export interface StartupPlayerPhases {
  startup_player_request_ms: number | null;
  startup_manifest_ms: number | null;
  startup_first_media_ms: number | null;
  startup_first_paint_ms: number | null;
}

export const EMPTY_STARTUP_PHASES: StartupPlayerPhases = {
  startup_player_request_ms: null,
  startup_manifest_ms: null,
  startup_first_media_ms: null,
  startup_first_paint_ms: null,
};

/**
 * Merge a fresh reading into a latched one, first non-null per phase winning.
 *
 * Two reasons a phase has to be latched rather than recomputed from scratch on
 * every report. The Resource Timing buffer is finite (~250 entries) and evicts
 * the join request on a long run, so a phase that *was* measured would revert
 * to unmeasured partway through the leg. And milestones land progressively:
 * the manifest is known long before the first painted frame, so a reading is
 * always partial at first and complete later.
 */
export function latchStartupPhases(
  current: StartupPlayerPhases,
  next: StartupPlayerPhases,
): StartupPlayerPhases {
  const merged: StartupPlayerPhases = { ...current };
  for (const key of Object.keys(EMPTY_STARTUP_PHASES) as (keyof StartupPlayerPhases)[]) {
    if (merged[key] == null) {
      merged[key] = next[key];
    }
  }
  return merged;
}

/** Milestones on one wall clock (epoch ms). `null` means never observed. */
export interface StartupMilestones {
  /** Player attach — t0 of the player chain. */
  attachAtMs?: number | null;
  requestSentAtMs?: number | null;
  manifestReceivedAtMs?: number | null;
  firstMediaAtMs?: number | null;
  firstPaintAtMs?: number | null;
  /**
   * False for engines with no manifest at all (a raw MPEG-TS pull: the first
   * response *is* the media). The phase then reports null-as-not-applicable
   * and its successor anchors to the previous milestone that did happen, so no
   * time is lost — see `startup_budget.PLAYER_PHASE_NOTES`.
   */
  manifestApplicable?: boolean;
}

/**
 * Phase durations from milestones, with the strictness of
 * `startup_budget._phase_between`.
 *
 * A phase is measured only when *both* its bounding milestones are. A missing
 * middle milestone is not papered over by stretching its neighbour across the
 * gap — that would move real time into whichever phase happened to have an
 * instrument. A not-applicable phase does not invalidate the anchor: there was
 * never a milestone there to miss.
 */
export function startupPhasesFromMilestones(
  milestones: StartupMilestones,
): StartupPlayerPhases {
  const { manifestApplicable = true } = milestones;
  const chain: ReadonlyArray<[keyof StartupPlayerPhases, number | null | undefined, boolean]> = [
    ["startup_player_request_ms", milestones.requestSentAtMs, true],
    ["startup_manifest_ms", milestones.manifestReceivedAtMs, manifestApplicable],
    ["startup_first_media_ms", milestones.firstMediaAtMs, true],
    ["startup_first_paint_ms", milestones.firstPaintAtMs, true],
  ];

  const phases: StartupPlayerPhases = { ...EMPTY_STARTUP_PHASES };
  let anchor = positive(milestones.attachAtMs);
  let anchorFresh = anchor !== null;
  for (const [column, instant, applicable] of chain) {
    if (!applicable) {
      continue;
    }
    const end = positive(instant);
    phases[column] = anchorFresh && anchor !== null && end !== null ? cleanPhaseMs(end - anchor) : null;
    if (end !== null) {
      anchor = end;
      anchorFresh = true;
    } else {
      anchorFresh = false;
    }
  }
  return phases;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The playa TTFF breakdown, as `@playa/player` reports it.
 *
 * Every field is **cumulative ms since `load()`** (verified in
 * `vendor/moq-playa/packages/player/src/stats.ts`: `snapshot()` maps absolute
 * `Date.now()` marks through `relativeMs()` against `loadStart`), so a phase is
 * the difference between two of them. `null` means the milestone has not been
 * reached.
 */
export interface PlayaTtffBreakdown {
  readonly transportConnectedMs?: number | null;
  readonly setupCompleteMs?: number | null;
  readonly catalogReceivedMs?: number | null;
  readonly firstObjectReceivedMs?: number | null;
  readonly decoderConfiguredMs?: number | null;
  readonly firstFrameRenderedMs?: number | null;
}

/**
 * Map playa's breakdown onto the four player-chain phases.
 *
 * Every offset shares one origin — `load()`, which *is* the MoQ player's attach
 * instant — so each phase is an exact difference of two milestones. Nothing
 * here is inferred by subtracting the other phases from the total, and no
 * Resource Timing is involved (a WebTransport session produces no resource
 * entry at all).
 *
 * The phase boundaries follow `PLAYER_PHASE_NOTES["moq"]` literally:
 * `player_request` ends at the WebTransport connect, and `manifest` starts at
 * SETUP complete. The MOQT SETUP round trip between them is therefore charged
 * to **neither** phase and surfaces in `startup_player_residual_ms`. That is
 * the intended reading: the residual is signed and visible, whereas folding
 * SETUP into a neighbouring phase would silently mislabel it.
 */
export function startupPhasesFromPlayaBreakdown(
  breakdown: PlayaTtffBreakdown | null | undefined,
): StartupPlayerPhases {
  if (!breakdown) {
    return { ...EMPTY_STARTUP_PHASES };
  }
  // load() is offset 0, so an offset of exactly 0 is a reached milestone and
  // must not be confused with an absent one — hence `>= 0`, not `> 0`.
  const at = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const span = (start: number | null, end: number | null): number | null =>
    start === null || end === null ? null : cleanPhaseMs(end - start);

  return {
    startup_player_request_ms: span(0, at(breakdown.transportConnectedMs)),
    startup_manifest_ms: span(at(breakdown.setupCompleteMs), at(breakdown.catalogReceivedMs)),
    startup_first_media_ms: span(
      at(breakdown.catalogReceivedMs),
      at(breakdown.firstObjectReceivedMs),
    ),
    startup_first_paint_ms: span(
      at(breakdown.firstObjectReceivedMs),
      at(breakdown.firstFrameRenderedMs),
    ),
  };
}

/**
 * Pull the TTFF breakdown off a `@playa/player` Player.
 *
 * The breakdown is produced by the MOQT engine (`vendor/moq-playa/packages/player`)
 * but the `@playa/player` façade's own `stats` getter projects a UI subset and
 * drops it, so the only route to it is the engine the façade wraps. That field
 * is `private` in TypeScript and an ordinary property at runtime; reaching it
 * needs a cast, which is why every value is validated on the way out rather
 * than trusted. Read-only — nothing under `vendor/` changes.
 *
 * The façade is tried first, so if a vendor upgrade starts forwarding
 * `ttffBreakdown` properly this switches to the supported path on its own. If
 * instead the engine field is renamed, this returns null and the MoQ startup
 * phases go back to *unmeasured* — a visible gap, not a silent zero.
 */
export function readPlayaTtffBreakdown(player: unknown): PlayaTtffBreakdown | null {
  if (!player || typeof player !== "object") {
    return null;
  }
  const candidates: unknown[] = [
    (player as { stats?: unknown }).stats,
    (player as { engine?: { stats?: unknown } }).engine?.stats,
  ];
  for (const stats of candidates) {
    if (!stats || typeof stats !== "object") {
      continue;
    }
    const breakdown = (stats as { ttffBreakdown?: unknown }).ttffBreakdown;
    if (breakdown && typeof breakdown === "object") {
      return breakdown as PlayaTtffBreakdown;
    }
  }
  return null;
}
