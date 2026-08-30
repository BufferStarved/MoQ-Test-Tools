import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyWhepEndVerdict, whepHasRenderedMedia, whepPlaybackBufferSec } from "./webrtcPlayback.ts";

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

  it("does not treat operator stop as a stall against the unused 300s cap", () => {
    const verdict = classifyWhepEndVerdict({
      framesRendered: 400,
      videoTimeSec: 28.9,
      encodeDurationSec: 300,
      encodeElapsedSec: 30,
      runStopped: true,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
  });

  it("uses actual encode elapsed, not the 300s default, when a freeze is real", () => {
    const verdict = classifyWhepEndVerdict({
      framesRendered: 400,
      videoTimeSec: 24.6,
      encodeDurationSec: 300,
      encodeElapsedSec: 62,
      runStopped: true,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /stalled at 24\.6s of a 62s encode/);
    assert.doesNotMatch(verdict.error ?? "", /300s/);
  });

  it("does not call Stop after paint a stall against leftover planned duration", () => {
    const verdict = classifyWhepEndVerdict({
      framesRendered: 900,
      videoTimeSec: 24.7,
      encodeDurationSec: 36,
      encodeElapsedSec: 36,
      runStopped: true,
      jobStatus: "completed",
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
    assert.equal(verdict.status, "Playback OK");
  });

  it("does not call Stop/detach at 54s of a 75s encode a mid-clip stall", () => {
    const verdict = classifyWhepEndVerdict({
      framesRendered: 1600,
      videoTimeSec: 54.0,
      encodeDurationSec: 75,
      encodeElapsedSec: 75,
      runStopped: true,
      jobStatus: "completed",
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
    assert.doesNotMatch(verdict.status, /Failed/i);
  });
});

describe("whepPlaybackBufferSec", () => {
  it("reports RTC jitter-buffer seconds when HTML buffered ranges are empty", () => {
    assert.equal(
      whepPlaybackBufferSec({ jitterBufferMs: 80, htmlBufferedAheadSec: 0 }),
      0.08,
    );
    assert.equal(whepPlaybackBufferSec({ htmlBufferedAheadSec: 1.2 }), 1.2);
  });
});
