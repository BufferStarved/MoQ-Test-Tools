import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moqCatchUpConfig } from "./encodeProfiles.ts";
import {
  classifyLocFrameStall,
  locPaintedOk,
  LOC_LATE_FRAME_THRESHOLD_MS,
  locSubscribeOptions,
  resetLocPlaybackPipeline,
} from "./moqLocPlayback.ts";

describe("locPaintedOk", () => {
  it("rejects leftover rendered=1 with 0x10 and no bitrate", () => {
    assert.equal(
      locPaintedOk({ framesRendered: 1, bitrateBps: 0, subscribeRejected: true }),
      false,
    );
    assert.equal(locPaintedOk({ framesRendered: 12, bitrateBps: 0 }), true);
    assert.equal(locPaintedOk({ framesRendered: 1, bitrateBps: 800_000 }), true);
  });
});

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

  it("caps LOC catch-up at 1.0× in complete playback", () => {
    assert.equal(moqCatchUpConfig(400, "loc", "complete").maxCatchUpRate, 1.0);
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

  it("resets the decoder after the stall limit when frames already painted", () => {
    assert.equal(classifyLocFrameStall({ ...base, nowMs: 10_000 }), "reset");
  });

  it("resets on early join instead of RESET_STREAM reconnect", () => {
    assert.equal(
      classifyLocFrameStall({
        ...base,
        framesRendered: 4,
        nowMs: 5_000,
        earlyWindow: true,
        stallLimitMs: 3_000,
      }),
      "reset",
    );
  });

  it("holds on early join after the decoder-reset budget", () => {
    assert.equal(
      classifyLocFrameStall({
        ...base,
        framesRendered: 4,
        nowMs: 5_000,
        earlyWindow: true,
        stallLimitMs: 3_000,
        decoderResets: 2,
      }),
      "hold",
    );
  });

  it("restarts after decoder resets when the encode is still live", () => {
    assert.equal(
      classifyLocFrameStall({
        ...base,
        framesRendered: 42,
        nowMs: 20_000,
        decoderResets: 2,
        sessionRestarts: 0,
      }),
      "restart",
    );
  });

  it("holds when the encode has already finished", () => {
    assert.equal(
      classifyLocFrameStall({
        ...base,
        framesRendered: 4,
        nowMs: 10_000,
        encodeFinished: true,
      }),
      "hold",
    );
  });

  it("restarts after decoder resets when there is no media and the encode is still live", () => {
    assert.equal(
      classifyLocFrameStall({ ...base, framesRendered: 0, nowMs: 10_000, decoderResets: 2 }),
      "restart",
    );
    assert.equal(
      classifyLocFrameStall({
        ...base,
        framesRendered: 0,
        nowMs: 10_000,
        decoderResets: 2,
        sessionRestarts: 3,
      }),
      "give_up",
    );
  });

  it("does not count a freeze while a reconnect is in flight", () => {
    assert.equal(classifyLocFrameStall({ ...base, nowMs: 10_000, retrying: true }), "ok");
  });
});

describe("resetLocPlaybackPipeline", () => {
  it("resets the engine pipeline without pause", () => {
    const calls: string[] = [];
    const player = {
      play: () => calls.push("play"),
      engine: {
        videoPipeline: { reset: () => calls.push("video") },
        syncController: { reset: () => calls.push("sync") },
      },
    };
    assert.equal(resetLocPlaybackPipeline(player), true);
    assert.deepEqual(calls, ["video", "sync", "play"]);
  });

  it("returns false when the engine has no pipeline", () => {
    assert.equal(resetLocPlaybackPipeline({ play: () => undefined }), false);
    assert.equal(resetLocPlaybackPipeline(null), false);
  });
});
