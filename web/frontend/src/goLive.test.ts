import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatGoLiveDiag,
  goLiveButtonVisible,
  goLiveHoldSec,
  latchGoLive,
  seekGoLive,
} from "./goLive.ts";

function fakeMedia(options: {
  currentTime: number;
  readyState?: number;
  ranges: Array<[number, number]>;
}): HTMLMediaElement {
  const ranges = options.ranges;
  return {
    currentTime: options.currentTime,
    readyState: options.readyState ?? 3,
    buffered: {
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    },
  } as HTMLMediaElement;
}

describe("goLiveButtonVisible", () => {
  it("hides on WHEP and LOC; shows on CMAF, HLS, MPEG-TS, DASH", () => {
    assert.equal(goLiveButtonVisible({ engine: "whep" }), false);
    assert.equal(goLiveButtonVisible({ engine: "webrtc" }), false);
    assert.equal(goLiveButtonVisible({ engine: "moq", packaging: "loc" }), false);
    assert.equal(goLiveButtonVisible({ engine: "moq", packaging: "cmaf" }), true);
    assert.equal(goLiveButtonVisible({ engine: "ll-hls" }), true);
    assert.equal(goLiveButtonVisible({ engine: "hls" }), true);
    assert.equal(goLiveButtonVisible({ engine: "mpegts" }), true);
    assert.equal(goLiveButtonVisible({ engine: "dash" }), true);
  });

  it("hides on upload-only even when the engine would otherwise show it", () => {
    assert.equal(goLiveButtonVisible({ engine: "hls", testScope: "upload" }), false);
    assert.equal(goLiveButtonVisible({ engine: "moq", packaging: "cmaf", testScope: "e2e" }), true);
  });
});

describe("goLiveHoldSec", () => {
  it("keeps CMAF / LL / HTTP-TS at a one-frame-class hold", () => {
    assert.equal(goLiveHoldSec("moq-cmaf"), 0.4);
    assert.equal(goLiveHoldSec("ll-hls"), 0.4);
    assert.equal(goLiveHoldSec("mpegts"), 0.4);
    assert.equal(goLiveHoldSec("dash"), 0.4);
  });

  it("does not chase Zixi Fast HLS below one TARGETDURATION", () => {
    assert.equal(goLiveHoldSec("hls", 2), 2);
    assert.equal(goLiveHoldSec("hls"), 2);
  });
});

describe("seekGoLive", () => {
  it("refuses a frozen playhead", () => {
    const media = fakeMedia({ currentTime: 4, readyState: 1, ranges: [[0, 8]] });
    assert.deepEqual(seekGoLive(media, 0.4), { ok: false, reason: "frozen" });
  });

  it("refuses a hole between the playhead and the live edge", () => {
    const media = fakeMedia({
      currentTime: 2,
      ranges: [
        [0, 3],
        [6, 10],
      ],
    });
    assert.deepEqual(seekGoLive(media, 0.4), { ok: false, reason: "hole" });
  });

  it("seeks to the end of the current range minus hold", () => {
    const media = fakeMedia({ currentTime: 2, ranges: [[0, 8]] });
    const result = seekGoLive(media, 0.4);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.toSec, 7.6);
      assert.equal(media.currentTime, 7.6);
    }
  });

  it("prefers hls.js liveSyncPosition when it is inside the range", () => {
    const media = fakeMedia({ currentTime: 1, ranges: [[0, 8]] });
    const result = seekGoLive(media, 0.4, 6.2);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.toSec, 6.2);
    }
  });
});

describe("latchGoLive", () => {
  it("keeps the first click so later samples do not rewrite the CSV", () => {
    const first = latchGoLive({ atSec: 0, e2eMs: 0 }, 12, 8800);
    assert.deepEqual(first, { atSec: 12, e2eMs: 8800 });
    // Live HUD e2e is a different field; the latch must stay at the pre-click glass.
    assert.deepEqual(latchGoLive(first, 40, 400), first);
  });

  it("formats the pre-click e2e into the diag line", () => {
    assert.match(formatGoLiveDiag({ ok: false, reason: "hole" }, 12, 8800), /go_live_at_sec=12 e2e=8800 refused=hole/);
  });
});
