import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyMpegTsEndVerdict,
  mpegTsMayMarkPlaybackOk,
  mpegTsPaintedOk,
} from "./mpegTsPlayback.ts";

describe("mpegTsPaintedOk", () => {
  it("rejects TTFF without a frame (comparison 29 Playback OK lie)", () => {
    assert.equal(mpegTsPaintedOk({ ttffMs: 1200, framesRendered: 0, videoWidth: 0 }), false);
    assert.equal(mpegTsPaintedOk({ ttffMs: 1200, framesRendered: 12 }), true);
  });
});

describe("mpegTsMayMarkPlaybackOk", () => {
  it("never marks Playback OK after a probe miss", () => {
    assert.equal(
      mpegTsMayMarkPlaybackOk({
        paintedOk: true,
        lastReason: "manifest unreachable",
      }),
      false,
    );
    assert.equal(
      mpegTsMayMarkPlaybackOk({
        paintedOk: true,
        lastReason: "HTTP 404",
      }),
      false,
    );
  });
});

describe("classifyMpegTsEndVerdict", () => {
  it("never marks Encode finished after zero paint", () => {
    const verdict = classifyMpegTsEndVerdict({ paintedOk: false });
    assert.equal(verdict.ok, false);
    assert.notEqual(verdict.status, "Playback OK");
    assert.notEqual(verdict.status, "Encode finished");
    assert.match(verdict.error, /never painted/i);
  });

  it("does not mark Playback OK after a mid-clip stall", () => {
    const verdict = classifyMpegTsEndVerdict({
      paintedOk: true,
      videoTimeSec: 18.757,
      encodeDurationSec: 26,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /stalled at 18.8s of a 26s encode/i);
  });
});
