import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyMpegTsEndVerdict,
  mpegTsFetchIdleSignal,
  mpegTsFrozenOriginReason,
  mpegTsIdleOriginReason,
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
        lastReason: mpegTsFrozenOriginReason("35.222.33.58:7777"),
      }),
      false,
    );
    assert.equal(
      mpegTsMayMarkPlaybackOk({
        paintedOk: true,
        lastReason: mpegTsIdleOriginReason("35.222.33.58:7777"),
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
    assert.equal(reason, mpegTsFrozenOriginReason("35.222.33.58:7777"));
    assert.match(reason, /did not respond/i);
    assert.match(reason, /frozen/i);
    assert.doesNotMatch(reason, /manifest unreachable/i);
    assert.doesNotMatch(reason, /sent no media/i);
    assert.equal(mpegTsOriginHost("/api/playback/fetch?url=" + encodeURIComponent("http://35.222.33.58:7777/SRT%20Test%20EC.ts")), "35.222.33.58:7777");
  });

  it("names a proxied 504 without idle signal as the same frozen-origin timeout", () => {
    const reason = mpegTsProbeFailReason({
      httpStatus: 504,
      originHost: "35.222.33.58:7777",
    });
    assert.equal(reason, mpegTsFrozenOriginReason("35.222.33.58:7777"));
    assert.doesNotMatch(reason, /sent no media/i);
  });

  it("names HTTP 200 + first-byte timeout as idle origin, not host-down", () => {
    const reason = mpegTsProbeFailReason({
      httpStatus: 504,
      originHost: "35.222.33.58:7777",
      upstreamStatus: 200,
      firstByteTimeout: true,
      headersReceived: true,
    });
    assert.equal(reason, mpegTsIdleOriginReason("35.222.33.58:7777", 200));
    assert.match(reason, /answered HTTP 200/i);
    assert.match(reason, /sent no media/i);
    assert.match(reason, /idle|unbounded/i);
    assert.doesNotMatch(reason, /did not respond/i);
    assert.doesNotMatch(reason, /frozen/i);
  });

  it("names HTTP 200 + 0 TS bytes as idle origin", () => {
    const reason = mpegTsProbeFailReason({
      httpStatus: 200,
      originHost: "35.222.33.58:7777",
      headersReceived: true,
      bytesReceived: 0,
      upstreamStatus: 200,
    });
    assert.equal(reason, mpegTsIdleOriginReason("35.222.33.58:7777", 200));
  });
});

describe("mpegTsFetchIdleSignal", () => {
  it("reads X-Playback-First-Byte=idle from the fetch proxy", () => {
    const idle = mpegTsFetchIdleSignal({
      httpStatus: 504,
      upstreamStatusHeader: "200",
      firstByteHeader: "idle",
    });
    assert.equal(idle.firstByteTimeout, true);
    assert.equal(idle.upstreamStatus, 200);
  });

  it("reads the JSON detail fallback when headers are stripped", () => {
    const idle = mpegTsFetchIdleSignal({
      httpStatus: 504,
      detail: "Playback fetch: origin answered HTTP 200 but sent no media",
    });
    assert.equal(idle.firstByteTimeout, true);
    assert.equal(idle.upstreamStatus, 200);
  });

  it("does not treat a plain host-down 504 as idle", () => {
    const idle = mpegTsFetchIdleSignal({
      httpStatus: 504,
      detail: "Playback fetch timed out",
    });
    assert.equal(idle.firstByteTimeout, false);
    assert.equal(idle.upstreamStatus, null);
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
