import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeDurationForEndVerdict,
  encodeElapsedSecForVerdict,
  playbackCoveredEncode,
  stallAgainstEncodeMessage,
} from "./playbackEndVerdict.ts";

describe("encodeElapsedSecForVerdict", () => {
  it("prefers the max sample elapsed over a stale latest of 0", () => {
    assert.equal(
      encodeElapsedSecForVerdict({
        latestElapsedSec: 0,
        sampleElapsedSecs: [10, 61.8, 40],
      }),
      61.8,
    );
  });

  it("falls back to wall clock when samples never reported elapsed", () => {
    assert.equal(
      encodeElapsedSecForVerdict({
        latestElapsedSec: 0,
        sampleElapsedSecs: [0, 0],
        startedAtEpoch: 1_700_000_000,
        completedAtMs: 1_700_000_062_000,
      }),
      62,
    );
  });
});

describe("encodeDurationForEndVerdict", () => {
  it("uses actual elapsed instead of the leftover 300s webcam cap", () => {
    assert.equal(
      encodeDurationForEndVerdict({
        encodeDurationSec: 300,
        encodeElapsedSec: 62,
        runStopped: true,
      }),
      62,
    );
  });

  it("does not invent 300s when Stop arrives before elapsed samples", () => {
    assert.equal(
      encodeDurationForEndVerdict({
        encodeDurationSec: 300,
        encodeElapsedSec: 0,
        runStopped: true,
      }),
      0,
    );
  });
});

describe("stallAgainstEncodeMessage", () => {
  it("does not say stalled at Xs of a 300s encode after a ~62s stop", () => {
    const message = stallAgainstEncodeMessage({
      protocolLabel: "WebRTC",
      videoTimeSec: 24.6,
      encodeDurationSec: 300,
      encodeElapsedSec: 62,
      runStopped: true,
    });
    assert.match(message, /stalled at 24\.6s of a 62s encode/);
    assert.doesNotMatch(message, /300s/);
  });

  it("treats operator stop near the playhead as covered, not a stall", () => {
    assert.equal(
      playbackCoveredEncode({
        videoTimeSec: 28.9,
        encodeDurationSec: 300,
        encodeElapsedSec: 30,
        runStopped: true,
      }),
      true,
    );
  });
});
