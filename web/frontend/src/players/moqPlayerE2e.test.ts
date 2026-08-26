import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeMoqE2eMs, holdE2eWhilePlayheadFrozen } from "../glassLatency.ts";
import { playaLatencyForMoqE2e } from "../moqCmafPlayback.ts";

/**
 * MoqPlayer.captureAnchoredE2eMs calling convention, without mounting React.
 * Comparison 26: post-seek hold 0.26s, encode 1453ms, reported e2e 4763
 * (extra above buffer stuck at ~4490ms).
 */
function playerCmafE2e(options: {
  videoTimeSec: number;
  aheadSec: number;
  epochSec: number;
  nowMs: number;
  joinOffsetSec?: number | null;
  playaLatencyMs?: number;
  encodeLatencyMs?: number;
  last?: { videoTimeSec: number; e2eMs: number };
}): { e2eMs: number | undefined; last: { videoTimeSec: number; e2eMs: number } | undefined } {
  const computed = computeMoqE2eMs({
    playerLatencyMs: playaLatencyForMoqE2e("cmaf", options.playaLatencyMs),
    encodeComponentMs: options.encodeLatencyMs,
    bufferMs: options.aheadSec * 1000,
    mediaPackaging: "cmaf",
    joinOffsetSec: options.joinOffsetSec ?? null,
    videoCurrentTimeSec: options.videoTimeSec,
    bufferedEndSec: options.videoTimeSec + options.aheadSec,
    epochSec: options.epochSec,
    nowMs: options.nowMs,
  });
  return holdE2eWhilePlayheadFrozen(computed, options.videoTimeSec, options.last);
}

describe("MoqPlayer CMAF e2e (comparison 26)", () => {
  const nowMs = 1_700_000_000_000;
  const videoT = 33.020942;
  const holdSec = 0.260291;
  const encodeMs = 1453.3;
  const wrongE2e = 4763;
  const epochSec = nowMs / 1000 - (wrongE2e / 1000 + videoT);

  it("does not keep a 4.5s floor above a 0.26s hold after seek", () => {
    const { e2eMs } = playerCmafE2e({
      videoTimeSec: videoT,
      aheadSec: holdSec,
      epochSec,
      nowMs,
      joinOffsetSec: null,
      playaLatencyMs: 4750,
      encodeLatencyMs: encodeMs,
    });
    const extra = (e2eMs ?? 0) - holdSec * 1000;
    assert.ok(extra < 2000, `e2e−buf must not stay ~4490ms, got ${extra}`);
    assert.ok(
      Math.abs((e2eMs ?? 0) - (holdSec * 1000 + encodeMs)) < 5,
      `e2e should be hold+encode, got ${e2eMs}`,
    );
  });

  it("holds last-good e2e while the playhead is frozen", () => {
    const moving = playerCmafE2e({
      videoTimeSec: videoT,
      aheadSec: holdSec,
      epochSec,
      nowMs,
      encodeLatencyMs: encodeMs,
    });
    const frozen = playerCmafE2e({
      videoTimeSec: videoT,
      aheadSec: holdSec + 1,
      epochSec,
      nowMs: nowMs + 1000,
      encodeLatencyMs: encodeMs,
      last: moving.last,
    });
    assert.equal(frozen.e2eMs, moving.e2eMs);
  });
});
