import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferDroppedFrames, locGlassDelayMs } from "./playbackTruth.ts";

describe("locGlassDelayMs", () => {
  it("stays near path/capture delay while frames are still painting", () => {
    assert.equal(
      locGlassDelayMs({ playerLatencyMs: 28, lastFrameAtMs: 5_000, nowMs: 5_200 }),
      28,
    );
  });

  it("ages the last painted frame when the canvas freezes", () => {
    const frozen = locGlassDelayMs({
      playerLatencyMs: 28,
      lastFrameAtMs: 5_000,
      nowMs: 5_000 + 36_000,
    });
    assert.ok((frozen ?? 0) > 30_000, `stale canvas must not stay at 28ms, got ${frozen}`);
  });

  it("does not post ~30ms path delay as glass delay while frozen", () => {
    const frozen = locGlassDelayMs({
      encodeLagMs: 6,
      rttMs: 38,
      firstFrameAtMs: 1_000,
      lastFrameAtMs: 2_400,
      nowMs: 2_400 + 36_000,
    });
    assert.ok((frozen ?? 0) > 20_000, `path delay must not win vs WebRTC, got ${frozen}`);
  });
});

describe("inferDroppedFrames", () => {
  it("infers missed LOC frames when playa reports 0 drops", () => {
    assert.equal(
      inferDroppedFrames({
        framesRendered: 42,
        reportedDropped: 0,
        firstFrameAtMs: 1_000,
        nowMs: 1_000 + 41_000,
        targetFps: 30,
      }),
      30 * 41 - 42,
    );
  });

  it("keeps WebRTC HTML/RTC drops when they exceed the inference", () => {
    assert.equal(
      inferDroppedFrames({
        framesRendered: 1256,
        reportedDropped: 457,
        firstFrameAtMs: 2_200,
        nowMs: 2_200 + 42_000,
        targetFps: 30,
      }),
      457,
    );
  });
});
