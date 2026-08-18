import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moqCatchUpConfig } from "./encodeProfiles.ts";
import {
  classifyLocFrameStall,
  LOC_LATE_FRAME_THRESHOLD_MS,
  locSubscribeOptions,
} from "./moqLocPlayback.ts";

describe("locSubscribeOptions", () => {
  it("joins live LOC with LargestObject and no current-GOP FETCH", () => {
    const opts = locSubscribeOptions();
    assert.equal(opts.subscriptionFilter.type, "LargestObject");
    assert.equal(opts.warmStartCurrentGroup, false);
    assert.equal(opts.lateFrameThresholdMs, LOC_LATE_FRAME_THRESHOLD_MS);
    assert.ok(opts.lateFrameThresholdMs > 5_000);
  });
});

describe("moqCatchUpConfig packaging", () => {
  it("keeps CMAF catch-up disabled (no CaptureTimestamp)", () => {
    assert.equal(moqCatchUpConfig(400, "cmaf").maxCatchUpRate, 1.0);
  });

  it("enables LOC catch-up so the canvas can close a live-edge gap", () => {
    assert.equal(moqCatchUpConfig(400, "loc").maxCatchUpRate, 1.25);
  });
});

describe("classifyLocFrameStall", () => {
  const base = {
    framesRendered: 278,
    lastAdvanceAtMs: 1_000,
    nowMs: 1_000,
    sessionRestarts: 0,
    stallLimitMs: 8_000,
    retrying: false,
  };

  it("is ok while frames are advancing", () => {
    assert.equal(classifyLocFrameStall({ ...base, nowMs: 4_000 }), "ok");
  });

  it("restarts after the stall limit, then gives up", () => {
    assert.equal(classifyLocFrameStall({ ...base, nowMs: 10_000 }), "restart");
    assert.equal(
      classifyLocFrameStall({ ...base, nowMs: 10_000, sessionRestarts: 3 }),
      "give_up",
    );
  });

  it("does not count a freeze while a reconnect is in flight", () => {
    assert.equal(classifyLocFrameStall({ ...base, nowMs: 10_000, retrying: true }), "ok");
  });
});
