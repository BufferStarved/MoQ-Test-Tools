import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyMpegTsEndVerdict,
  mpegTsMayMarkPlaybackOk,
  mpegTsOriginHost,
  mpegTsPaintedOk,
  mpegTsProbeFailReason,
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
    assert.equal(
      mpegTsMayMarkPlaybackOk({
        paintedOk: true,
        lastReason:
          "HTTP-TS probe timed out — 35.222.33.58:7777 did not respond (origin may be frozen). This is not playback OK.",
      }),
      false,
    );
  });
});

describe("mpegTsProbeFailReason", () => {
  it("names a :7777 signal timeout as a frozen origin, not manifest unreachable", () => {
    const reason = mpegTsProbeFailReason({
      fetchError: "signal timed out",
      originHost: mpegTsOriginHost("http://35.222.33.58:7777/benchmark.ts"),
    });
    assert.match(reason, /35\.222\.33\.58:7777/);
    assert.match(reason, /timed out/i);
    assert.match(reason, /frozen/i);
    assert.doesNotMatch(reason, /manifest unreachable/i);
    assert.equal(mpegTsOriginHost("/api/playback/fetch?url=" + encodeURIComponent("http://35.222.33.58:7777/SRT%20Test%20EC.ts")), "35.222.33.58:7777");
  });

  it("names a proxied 504 as the same frozen-origin timeout", () => {
    const reason = mpegTsProbeFailReason({
      httpStatus: 504,
      originHost: "35.222.33.58:7777",
    });
    assert.match(reason, /timed out/i);
    assert.match(reason, /35\.222\.33\.58:7777/);
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
