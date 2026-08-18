import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyMoqEndVerdict,
  isPublisherNotReadyError,
  moqHasRenderedMedia,
  noMediaFailMessage,
  noMediaTimeoutMs,
  shouldKeepSessionOnSubscribeError,
  MOQ_ALL_TRACKS_REFUSED,
  MOQ_NO_MEDIA_TIMEOUT_MS,
  MOQ_SUBSCRIPTION_REFUSED,
} from "./moqCmafPlayback.ts";

describe("moqHasRenderedMedia", () => {
  it("rejects ttff-only or zeros (CSV 2026-08-18 black player)", () => {
    assert.equal(moqHasRenderedMedia({}), false);
    assert.equal(moqHasRenderedMedia({ firstFrame: false, framesRendered: 0, videoTimeSec: 0 }), false);
  });

  it("accepts first frame, rendered frames, or a real playhead", () => {
    assert.equal(moqHasRenderedMedia({ firstFrame: true }), true);
    assert.equal(moqHasRenderedMedia({ framesRendered: 12 }), true);
    assert.equal(moqHasRenderedMedia({ videoTimeSec: 0.3 }), true);
    assert.equal(moqHasRenderedMedia({ videoTimeSec: 0.2 }), false);
  });
});

describe("shouldKeepSessionOnSubscribeError", () => {
  it("keeps the session on 0x10-class refusals before first frame", () => {
    assert.equal(
      shouldKeepSessionOnSubscribeError({ firstFrame: false, code: MOQ_SUBSCRIPTION_REFUSED }),
      true,
    );
    assert.equal(
      shouldKeepSessionOnSubscribeError({ firstFrame: false, code: MOQ_ALL_TRACKS_REFUSED }),
      true,
    );
    assert.equal(isPublisherNotReadyError(4865), true);
  });

  it("does not swallow a mid-play fatal", () => {
    assert.equal(
      shouldKeepSessionOnSubscribeError({ firstFrame: true, code: MOQ_SUBSCRIPTION_REFUSED }),
      false,
    );
  });
});

describe("noMediaTimeoutMs", () => {
  it("fails inside a 60s BBB instead of retrying past EOS", () => {
    assert.equal(noMediaTimeoutMs(60), MOQ_NO_MEDIA_TIMEOUT_MS);
    assert.ok(noMediaTimeoutMs(60) < 20_000);
  });

  it("shortens for a 20s clip", () => {
    assert.equal(noMediaTimeoutMs(20), 8_000);
  });
});

describe("classifyMoqEndVerdict", () => {
  it("is a visible failure when encode ran and nothing rendered", () => {
    const verdict = classifyMoqEndVerdict({
      firstFrame: false,
      framesRendered: 0,
      videoTimeSec: 0,
      catalogReady: false,
      encodeDurationSec: 60,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /catalog never loaded/i);
  });

  it("is a visible failure when catalog arrived but MSE never painted", () => {
    const verdict = classifyMoqEndVerdict({
      catalogReady: true,
      framesRendered: 0,
      videoTimeSec: 0,
      encodeDurationSec: 60,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /no video frames/i);
  });

  it("does not treat encode-only + fake e2e as Playback OK", () => {
    const verdict = classifyMoqEndVerdict({
      firstFrame: false,
      videoTimeSec: 0,
      encodeDurationSec: 60,
      lastError: null,
    });
    assert.equal(verdict.ok, false);
    assert.notEqual(verdict.status, "Playback OK");
  });

  it("reports a mid-clip stall when some media played", () => {
    const verdict = classifyMoqEndVerdict({
      firstFrame: true,
      videoTimeSec: 12.4,
      encodeDurationSec: 60,
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /stalled at 12.4s/);
  });
});

describe("noMediaFailMessage", () => {
  it("names the namespace so a 0x10 miss is diagnosable", () => {
    assert.match(noMediaFailMessage({ catalogReady: false, namespace: "bench-6a9355b9" }), /bench-6a9355b9/);
  });
});
