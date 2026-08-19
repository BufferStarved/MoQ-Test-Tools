import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyWhepEndVerdict, whepHasRenderedMedia } from "./webrtcPlayback.ts";

describe("whepHasRenderedMedia", () => {
  it("rejects a single frame or zeros (CSV 2026-08-19 black WHEP)", () => {
    assert.equal(whepHasRenderedMedia({}), false);
    assert.equal(whepHasRenderedMedia({ framesRendered: 0 }), false);
    assert.equal(whepHasRenderedMedia({ framesRendered: 1 }), false);
    assert.equal(whepHasRenderedMedia({ framesRendered: 8 }), true);
  });
});

describe("classifyWhepEndVerdict", () => {
  it("keeps the WHIP/WHEP error when nothing rendered", () => {
    const verdict = classifyWhepEndVerdict({
      framesRendered: 0,
      videoTimeSec: 11.198,
      lastError: "WHEP ICE failed. MediaMTX is not reachable from this browser.",
      encodeDurationSec: 60,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /WHEP ICE failed/);
  });

  it("does not treat one frame + encode-only as Playback OK", () => {
    const verdict = classifyWhepEndVerdict({
      framesRendered: 1,
      videoTimeSec: 11.198,
      encodeDurationSec: 60,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /no video frames/i);
  });

  it("reports a mid-clip stall once real frames existed", () => {
    const verdict = classifyWhepEndVerdict({
      framesRendered: 40,
      videoTimeSec: 11.2,
      encodeDurationSec: 60,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /stalled at 11.2s/);
  });
});
