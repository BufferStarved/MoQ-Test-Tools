import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeMoqE2eMs, pathDelayMs, playheadAnchoredE2eMs } from "./glassLatency.ts";

describe("computeMoqE2eMs", () => {
  it("uses CaptureTimestamp-style player latency when present", () => {
    assert.equal(
      computeMoqE2eMs({ playerLatencyMs: 220, bridgeMs: 30, mediaPackaging: "loc" }),
      250,
    );
  });

  it("falls back to encode-epoch + playhead for CMAF when join offset is null", () => {
    const nowMs = 1_700_000_000_000;
    const epochSec = nowMs / 1000 - 10;
    assert.equal(
      computeMoqE2eMs({
        mediaPackaging: "cmaf",
        joinOffsetSec: null,
        epochSec,
        videoCurrentTimeSec: 8.5,
        nowMs,
        ttffMs: 556,
      }),
      1500,
    );
  });

  it("uses TTFF + playhead when epoch and join offset are both missing", () => {
    const firstFrameAtMs = 1_000_000;
    assert.equal(
      playheadAnchoredE2eMs({
        ttffMs: 556,
        firstFrameAtMs,
        firstFrameVideoSec: 0.25,
        nowMs: firstFrameAtMs + 10_000,
        videoTimeSec: 10.25,
        bridgeMs: 0,
      }),
      556,
    );
    assert.equal(
      computeMoqE2eMs({
        mediaPackaging: "cmaf",
        joinOffsetSec: null,
        epochSec: 0,
        videoCurrentTimeSec: 10.25,
        ttffMs: 556,
        firstFrameAtMs,
        firstFrameVideoSec: 0.25,
        nowMs: firstFrameAtMs + 10_000,
      }),
      556,
    );
  });

  it("grows TTFF-anchored e2e when the playhead freezes", () => {
    const firstFrameAtMs = 1_000_000;
    assert.equal(
      playheadAnchoredE2eMs({
        ttffMs: 556,
        firstFrameAtMs,
        firstFrameVideoSec: 0,
        nowMs: firstFrameAtMs + 20_000,
        videoTimeSec: 12.43,
        bridgeMs: 0,
      }),
      8126,
    );
  });

  it("uses the WHEP path-delay family when frames show but no clocks exist", () => {
    assert.equal(
      pathDelayMs({ encodeLagMs: 0, rttMs: 36, playerBufferMs: 0 }),
      18,
    );
    assert.equal(
      computeMoqE2eMs({
        mediaPackaging: "cmaf",
        encoderLagMs: 120,
        rttMs: 36,
        bufferMs: 40,
        videoCurrentTimeSec: 1,
      }),
      178,
    );
  });
});
