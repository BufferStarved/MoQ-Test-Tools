import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeMoqE2eMs,
  encodeAnchoredE2eMs,
  holdE2eWhilePlayheadFrozen,
  isMediaTimelineJoinOffset,
  pathDelayMs,
  playheadAnchoredE2eMs,
  resolveEncodeMediaAnchor,
  usablePackagerTransitMs,
} from "./glassLatency.ts";

describe("computeMoqE2eMs", () => {
  it("uses CaptureTimestamp-style player latency when present", () => {
    assert.equal(
      computeMoqE2eMs({ playerLatencyMs: 220, bridgeMs: 30, mediaPackaging: "loc" }),
      250,
    );
  });

  it("does not grow LOC e2e with media time when playhead is frames/30", () => {
    const firstFrameAtMs = 1_000_000;
    const earlyNow = firstFrameAtMs + 2_000;
    const lateNow = firstFrameAtMs + 20_000;
    const early = computeMoqE2eMs({
      mediaPackaging: "loc",
      encoderLagMs: 8,
      rttMs: 40,
      bufferMs: 20,
      ttffMs: 400,
      firstFrameAtMs,
      lastFrameAtMs: earlyNow,
      firstFrameVideoSec: 0,
      videoCurrentTimeSec: 2,
      nowMs: earlyNow,
    });
    const late = computeMoqE2eMs({
      mediaPackaging: "loc",
      encoderLagMs: 8,
      rttMs: 40,
      bufferMs: 20,
      ttffMs: 400,
      firstFrameAtMs,
      lastFrameAtMs: lateNow,
      firstFrameVideoSec: 0,
      videoCurrentTimeSec: 18,
      nowMs: lateNow,
    });
    assert.equal(early, late);
    assert.ok((early ?? 0) < 200);
  });

  it("does not report ~30ms LOC glass delay while the playhead is frozen", () => {
    const firstFrameAtMs = 1_000_000;
    const frozen = computeMoqE2eMs({
      mediaPackaging: "loc",
      encoderLagMs: 6,
      rttMs: 38,
      bufferMs: 0,
      firstFrameAtMs,
      lastFrameAtMs: firstFrameAtMs + 1_400,
      nowMs: firstFrameAtMs + 36_000,
    });
    assert.ok((frozen ?? 0) > 20_000, `stale canvas must not stay at path delay, got ${frozen}`);
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

  it("grows LOC e2e with stall time when the canvas stops painting", () => {
    const lastFrameAtMs = 1_000_000;
    const live = computeMoqE2eMs({
      mediaPackaging: "loc",
      playerLatencyMs: 28,
      lastFrameAtMs,
      nowMs: lastFrameAtMs + 200,
    });
    const frozen = computeMoqE2eMs({
      mediaPackaging: "loc",
      playerLatencyMs: 28,
      lastFrameAtMs,
      nowMs: lastFrameAtMs + 20_000,
    });
    assert.equal(live, 28);
    assert.ok((frozen ?? 0) > 15_000, `frozen LOC e2e should age the stale frame, got ${frozen}`);
  });

  it("does not report join-offset as HTTP-TS / CMAF glass of the painted frame", () => {
    const nowMs = 1_700_000_000_000;
    const epochSec = nowMs / 1000 - 8.9;
    const joinOffset = encodeAnchoredE2eMs({
      epochSec,
      rawVideoTimeSec: 0.5,
      nowMs,
      bufferedEndSec: 1.0,
    });
    assert.ok((joinOffset ?? 0) < 1500, `join-offset 8.9s must not be glass, got ${joinOffset}`);
    assert.ok((joinOffset ?? 0) >= 400, `live-edge rebase should track the 0.5s buffer, got ${joinOffset}`);
  });

  it("does not bake wall-clock attach delay into CMAF joinOffset", () => {
    const nowMs = 1_700_000_000_000;
    const epochSec = nowMs / 1000 - 8.9;
    const e2e = computeMoqE2eMs({
      mediaPackaging: "cmaf",
      joinOffsetSec: 8.9,
      epochSec,
      videoCurrentTimeSec: 0.2,
      bufferedEndSec: 0.7,
      nowMs,
    });
    assert.ok((e2e ?? 0) < 1500, `wall-attach join must not floor e2e, got ${e2e}`);
  });

  it("uses tfdt joinOffset so e2e is not ~4s above the HTML buffer", () => {
    const nowMs = 1_700_000_000_000;
    const epochSec = nowMs / 1000 - 8.8;
    const e2e = computeMoqE2eMs({
      mediaPackaging: "cmaf",
      joinOffsetSec: 4.3,
      epochSec,
      videoCurrentTimeSec: 0.2,
      bufferMs: 4300,
      nowMs,
    });
    assert.ok(e2e != null && e2e < 5500, `tfdt join should remove the 4.3s floor, got ${e2e}`);
    assert.ok(e2e != null && e2e > 3500);
  });

  it("holds last-good e2e while the playhead is frozen", () => {
    const first = holdE2eWhilePlayheadFrozen(4300, 50.38, undefined);
    const stalled = holdE2eWhilePlayheadFrozen(5300, 50.38, first.last);
    assert.equal(stalled.e2eMs, 4300);
    const seeked = holdE2eWhilePlayheadFrozen(800, 56.1, stalled.last);
    assert.equal(seeked.e2eMs, 800);
  });

  it("drops a one-shot packager transit that is just elapsed-minus-1s", () => {
    const nowMs = 1_700_000_000_000;
    const epochSec = nowMs / 1000 - 5.6;
    const pdtMs = nowMs - 200;
    assert.equal(
      usablePackagerTransitMs({
        transitMs: 4600,
        playheadPdtMs: pdtMs,
        epochSec,
      }),
      0,
    );
    assert.equal(
      usablePackagerTransitMs({
        transitMs: 520,
        playheadPdtMs: pdtMs + 20_000,
        epochSec,
      }),
      520,
    );
  });

  it("ignores playa CaptureTimestamp latency on the CMAF path", () => {
    const nowMs = 1_700_000_000_000;
    const epochSec = nowMs / 1000 - 10;
    const e2e = computeMoqE2eMs({
      mediaPackaging: "cmaf",
      playerLatencyMs: 4750,
      joinOffsetSec: null,
      epochSec,
      videoCurrentTimeSec: 8.5,
      bufferedEndSec: 8.76,
      encodeComponentMs: 1453,
      nowMs,
    });
    assert.ok(e2e != null && e2e < 2500, `CMAF must not adopt playa 4750ms, got ${e2e}`);
    assert.ok((e2e ?? 0) > 1400, `live-edge rebase should keep encode + hold, got ${e2e}`);
  });

  it("rejects wall-attach join at first paint vt≈1.0 (comparison 26)", () => {
    assert.equal(isMediaTimelineJoinOffset(8.9, 1.045, 8.9), false);
    assert.equal(isMediaTimelineJoinOffset(4.3, 0.2, 8.8), true);
  });

  it("rebases off bufferedEnd after vt>1.5 when tfdt join is missing", () => {
    const nowMs = 1_700_000_000_000;
    const videoT = 33.020942;
    const holdSec = 0.260291;
    const encodeMs = 1453.3;
    const wrongE2e = 4763;
    const epochSec = nowMs / 1000 - (wrongE2e / 1000 + videoT);
    const anchor = resolveEncodeMediaAnchor({
      epochSec,
      rawVideoTimeSec: videoT,
      nowMs,
      joinOffsetSec: null,
      bufferedEndSec: videoT + holdSec,
    });
    assert.equal(anchor?.kind, "live-edge");
    const e2e = computeMoqE2eMs({
      mediaPackaging: "cmaf",
      joinOffsetSec: null,
      epochSec,
      videoCurrentTimeSec: videoT,
      bufferedEndSec: videoT + holdSec,
      encodeComponentMs: encodeMs,
      nowMs,
    });
    const extra = (e2e ?? 0) - holdSec * 1000;
    assert.ok(extra < 2000, `comparison 26 extra must not stay ~4490ms, got ${extra}`);
    assert.ok(
      Math.abs((e2e ?? 0) - (holdSec * 1000 + encodeMs)) < 5,
      `post-seek e2e should be hold+encode, got ${e2e}`,
    );
  });

  it("always uses tfdt join + currentTime when the join is media-timeline", () => {
    const nowMs = 1_700_000_000_000;
    const epochSec = nowMs / 1000 - 37.783;
    const e2e = computeMoqE2eMs({
      mediaPackaging: "cmaf",
      joinOffsetSec: 4.3,
      epochSec,
      videoCurrentTimeSec: 33.02,
      bufferedEndSec: 33.28,
      encodeComponentMs: 1453,
      nowMs,
    });
    // mediaPos = 4.3 + 33.02 = 37.32; e2e = 37783 - 37320 = 463 (hold class)
    assert.ok(e2e != null && e2e < 800, `tfdt join must remove the 4.5s floor, got ${e2e}`);
    assert.equal(resolveEncodeMediaAnchor({
      epochSec,
      rawVideoTimeSec: 33.02,
      nowMs,
      joinOffsetSec: 4.3,
      bufferedEndSec: 33.28,
    })?.kind, "join");
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
