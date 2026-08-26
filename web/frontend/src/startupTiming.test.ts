import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findStartupResourceTiming,
  isOpaqueResourceTiming,
  latchStartupPhases,
  readPlayaTtffBreakdown,
  readResourceTiming,
  resourceTimingNameMatches,
  startupPhasesFromMilestones,
  startupPhasesFromPlayaBreakdown,
  type ResourceTimingMarks,
} from "./startupTiming.ts";

const EMPTY = {
  startup_player_request_ms: null,
  startup_manifest_ms: null,
  startup_first_media_ms: null,
  startup_first_paint_ms: null,
};

/** A same-origin entry with every mark visible. */
function entry(overrides: Partial<ResourceTimingMarks> = {}): ResourceTimingMarks {
  return {
    name: "https://app.example/api/playback/fetch?url=https%3A%2F%2Fmedia.example%2Findex.m3u8",
    fetchStart: 1000,
    domainLookupStart: 1010,
    domainLookupEnd: 1030,
    connectStart: 1030,
    connectEnd: 1090,
    secureConnectionStart: 1050,
    requestStart: 1100,
    responseStart: 1180,
    responseEnd: 1220,
    ...overrides,
  };
}

/**
 * A cross-origin response without Timing-Allow-Origin: fetchStart and
 * responseEnd are real, every interior mark is reported as 0.
 */
function opaqueEntry(): ResourceTimingMarks {
  return entry({
    name: "https://media.example/index.m3u8",
    fetchStart: 1000,
    domainLookupStart: 0,
    domainLookupEnd: 0,
    connectStart: 0,
    connectEnd: 0,
    secureConnectionStart: 0,
    requestStart: 0,
    responseStart: 0,
    responseEnd: 1220,
  });
}

test("a normal entry splits into request and manifest phases", () => {
  const timing = readResourceTiming(entry(), 5_000_000);
  assert.equal(timing.requestMs, 100); // requestStart - fetchStart
  assert.equal(timing.manifestMs, 120); // responseEnd - requestStart
  assert.equal(timing.domainLookupMs, 20);
  assert.equal(timing.connectMs, 60);
  assert.equal(timing.tlsMs, 40); // connectEnd - secureConnectionStart
  assert.equal(timing.opaque, false);
  // Milestones come back on the wall clock so they can anchor later phases.
  assert.equal(timing.requestSentAtMs, 5_001_100);
  assert.equal(timing.responseStartAtMs, 5_001_180);
  assert.equal(timing.responseEndAtMs, 5_001_220);
});

test("a never-ending response still has a first-byte milestone", () => {
  // A live MPEG-TS pull streams for the whole run, so responseEnd stays 0 and
  // responseStart is the only instant that says when media began.
  const timing = readResourceTiming(entry({ responseEnd: 0 }), 5_000_000);
  assert.equal(timing.responseStartAtMs, 5_001_180);
  assert.equal(timing.responseEndAtMs, null);
  assert.equal(timing.requestMs, 100);
});

test("an opaque cross-origin entry reports null, not a 0 ms connect", () => {
  // This is the whole honesty risk of the stage. Without Timing-Allow-Origin
  // requestStart is 0, so `requestStart - fetchStart` is NEGATIVE and
  // `responseEnd - requestStart` is the entire request — read naively that
  // charts "DNS + connect + TLS were free" on exactly the legs where they
  // were slowest, and hides the whole request inside the manifest phase.
  const opaque = opaqueEntry();
  assert.equal(isOpaqueResourceTiming(opaque), true);
  const timing = readResourceTiming(opaque, 5_000_000);
  assert.equal(timing.opaque, true);
  assert.equal(timing.requestMs, null);
  assert.equal(timing.manifestMs, null);
  assert.equal(timing.domainLookupMs, null);
  assert.equal(timing.connectMs, null);
  assert.equal(timing.tlsMs, null);
  assert.equal(timing.requestSentAtMs, null);
  assert.equal(timing.responseEndAtMs, null);
});

test("a missing entry reports null and does not claim opacity", () => {
  const timing = readResourceTiming(undefined, 5_000_000);
  assert.equal(timing.requestMs, null);
  assert.equal(timing.manifestMs, null);
  // Absent (evicted from the ~250-entry buffer, or never issued) is a
  // different diagnosis from present-but-opaque, and the operator needs both.
  assert.equal(timing.opaque, false);
});

test("an in-flight entry has no responseEnd, so only the request phase reads", () => {
  const timing = readResourceTiming(entry({ responseEnd: 0, responseStart: 0 }), 0);
  assert.equal(timing.requestMs, 100);
  assert.equal(timing.manifestMs, null);
});

test("plain HTTP has no TLS mark to report", () => {
  const timing = readResourceTiming(entry({ secureConnectionStart: 0 }), 0);
  assert.equal(timing.tlsMs, null);
  assert.equal(timing.connectMs, 60);
});

test("a mark past the sanity ceiling is dropped, not clamped", () => {
  const timing = readResourceTiming(entry({ requestStart: 900_000, responseEnd: 900_100 }), 0);
  assert.equal(timing.requestMs, null);
  assert.equal(timing.manifestMs, 100);
});

test("the proxied entry name resolves back to the media URL", () => {
  const media = "https://media.example/index.m3u8";
  assert.equal(resourceTimingNameMatches(entry().name, media), true);
  assert.equal(resourceTimingNameMatches(media, media), true);
  assert.equal(resourceTimingNameMatches("https://other.example/x.m3u8", media), false);
  assert.equal(resourceTimingNameMatches("", media), false);
});

test("the first request to a URL is the one that paid for DNS and connect", () => {
  // Manifest polling reuses the warm connection, so a later entry reports a
  // genuine 0 ms connect. Picking the newest match would report "no connect
  // cost" for a join that spent 100ms establishing one.
  const first = entry({ name: "https://media.example/index.m3u8", requestStart: 1100 });
  const reused = entry({
    name: "https://media.example/index.m3u8",
    fetchStart: 4000,
    domainLookupStart: 4000,
    domainLookupEnd: 4000,
    connectStart: 4000,
    connectEnd: 4000,
    secureConnectionStart: 0,
    requestStart: 4000,
    responseStart: 4010,
    responseEnd: 4020,
  });
  const timing = findStartupResourceTiming("https://media.example/index.m3u8", [first, reused], 0);
  assert.equal(timing.requestMs, 100);
});

test("no matching entry in a populated buffer is still null", () => {
  const timing = findStartupResourceTiming("https://media.example/index.m3u8", [entry({ name: "x" })], 0);
  assert.equal(timing.requestMs, null);
  assert.equal(timing.manifestMs, null);
});

test("phases are durations between milestones on one clock", () => {
  const phases = startupPhasesFromMilestones({
    attachAtMs: 1_000_000,
    requestSentAtMs: 1_000_100,
    manifestReceivedAtMs: 1_000_400,
    firstMediaAtMs: 1_002_400,
    firstPaintAtMs: 1_003_000,
  });
  assert.deepEqual(phases, {
    startup_player_request_ms: 100,
    startup_manifest_ms: 300,
    startup_first_media_ms: 2000,
    startup_first_paint_ms: 600,
  });
  // The chain reconciles against the measured total it will be compared with.
  const sum = Object.values(phases).reduce((total, value) => total + (value ?? 0), 0);
  assert.equal(sum, 3000);
});

test("a missing middle milestone does not stretch its neighbour across the gap", () => {
  // Stretching would move the manifest's time into first_media, which is the
  // misattribution the whole family exists to prevent.
  const phases = startupPhasesFromMilestones({
    attachAtMs: 1_000_000,
    requestSentAtMs: 1_000_100,
    manifestReceivedAtMs: null,
    firstMediaAtMs: 1_002_400,
    firstPaintAtMs: 1_003_000,
  });
  assert.equal(phases.startup_player_request_ms, 100);
  assert.equal(phases.startup_manifest_ms, null);
  assert.equal(phases.startup_first_media_ms, null);
  // The paint phase is bounded on both sides and survives.
  assert.equal(phases.startup_first_paint_ms, 600);
});

test("an engine with no manifest anchors first_media to the request instead", () => {
  // Raw MPEG-TS: the first response IS the media. Reporting a 0 ms manifest
  // would imply an instant fetch; leaving the phase null keeps the time in
  // first_media where it actually happened.
  const phases = startupPhasesFromMilestones({
    attachAtMs: 1_000_000,
    requestSentAtMs: 1_000_100,
    manifestApplicable: false,
    firstMediaAtMs: 1_000_900,
    firstPaintAtMs: 1_001_500,
  });
  assert.equal(phases.startup_manifest_ms, null);
  assert.equal(phases.startup_first_media_ms, 800);
  assert.equal(phases.startup_first_paint_ms, 600);
});

test("no attach instant means nothing in the chain is measured", () => {
  const phases = startupPhasesFromMilestones({ requestSentAtMs: 1_000_100 });
  assert.equal(phases.startup_player_request_ms, null);
  assert.equal(phases.startup_manifest_ms, null);
});

test("playa's cumulative offsets difference into the four phases", () => {
  const phases = startupPhasesFromPlayaBreakdown({
    transportConnectedMs: 120,
    setupCompleteMs: 160,
    catalogReceivedMs: 640,
    firstObjectReceivedMs: 1140,
    decoderConfiguredMs: 1180,
    firstFrameRenderedMs: 1300,
  });
  assert.equal(phases.startup_player_request_ms, 120);
  assert.equal(phases.startup_manifest_ms, 480); // catalog - setup
  assert.equal(phases.startup_first_media_ms, 500); // first object - catalog
  assert.equal(phases.startup_first_paint_ms, 160); // first frame - first object
});

test("a playa milestone not yet reached leaves its phases null", () => {
  const phases = startupPhasesFromPlayaBreakdown({
    transportConnectedMs: 120,
    setupCompleteMs: 160,
    catalogReceivedMs: null,
    firstObjectReceivedMs: null,
    firstFrameRenderedMs: null,
  });
  assert.equal(phases.startup_player_request_ms, 120);
  assert.equal(phases.startup_manifest_ms, null);
  assert.equal(phases.startup_first_media_ms, null);
  assert.equal(phases.startup_first_paint_ms, null);
});

test("no playa breakdown at all is four nulls, not four zeros", () => {
  assert.deepEqual(startupPhasesFromPlayaBreakdown(null), {
    startup_player_request_ms: null,
    startup_manifest_ms: null,
    startup_first_media_ms: null,
    startup_first_paint_ms: null,
  });
});

test("a measured phase survives its Resource Timing entry being evicted", () => {
  // The resource buffer holds ~250 entries. Recomputing from scratch on every
  // 1s report would silently turn a measured phase back into an unmeasured one
  // partway through a long leg.
  const measured = { ...EMPTY, startup_player_request_ms: 100, startup_manifest_ms: 300 };
  const evicted = { ...EMPTY, startup_first_media_ms: 2000 };
  assert.deepEqual(latchStartupPhases(measured, evicted), {
    startup_player_request_ms: 100,
    startup_manifest_ms: 300,
    startup_first_media_ms: 2000,
    startup_first_paint_ms: null,
  });
});

test("a latched phase is not overwritten by a later zero", () => {
  const measured = { ...EMPTY, startup_manifest_ms: 300 };
  const reconnect = { ...EMPTY, startup_manifest_ms: 0 };
  assert.equal(latchStartupPhases(measured, reconnect).startup_manifest_ms, 300);
});

test("the playa breakdown is read through the engine the facade wraps", () => {
  // @playa/player's own `stats` getter projects a UI subset and drops
  // ttffBreakdown, so the engine is the only route to it. If a vendor upgrade
  // forwards it properly the facade wins; if the engine field is renamed this
  // returns null and MoQ reports unmeasured rather than zero.
  const breakdown = { transportConnectedMs: 12, setupCompleteMs: 14 };
  assert.equal(readPlayaTtffBreakdown({ engine: { stats: { ttffBreakdown: breakdown } } }), breakdown);
  assert.equal(readPlayaTtffBreakdown({ stats: { ttffBreakdown: breakdown } }), breakdown);
  // Facade-only stats (today's shape) carry no breakdown at all.
  assert.equal(readPlayaTtffBreakdown({ stats: { timeToFirstFrameMs: 900 } }), null);
  assert.equal(readPlayaTtffBreakdown({ engine: { stats: { ttffBreakdown: null } } }), null);
  assert.equal(readPlayaTtffBreakdown(null), null);
});

test("a milestone reached at offset 0 is reached, not absent", () => {
  const phases = startupPhasesFromPlayaBreakdown({
    transportConnectedMs: 0,
    setupCompleteMs: 0,
    catalogReceivedMs: 40,
  });
  // A connect inside the measurement resolution really is 0 ms.
  assert.equal(phases.startup_player_request_ms, 0);
  assert.equal(phases.startup_manifest_ms, 40);
});
