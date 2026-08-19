import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCmafPlayheadStall,
  classifyMoqEndVerdict,
  cmafSubscribeOptions,
  humanizeJobError,
  isCaptureOrPublishError,
  isPublisherNotReadyError,
  moqHasRenderedMedia,
  moqRenderSink,
  noMediaFailMessage,
  noMediaTimeoutMs,
  playerErrorForFailedJob,
  shouldKeepSessionOnSubscribeError,
  CMAF_LATE_FRAME_THRESHOLD_MS,
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

describe("capture error mapping", () => {
  const capture251 =
    "Shared webcam capture exited immediately (code 251): Selected framerate (30.000000) is not supported";

  it("recognizes ffmpeg 251 / avfoundation as a capture error", () => {
    assert.equal(isCaptureOrPublishError(capture251), true);
    assert.equal(isCaptureOrPublishError("MoQ catalog never loaded"), false);
  });

  it("surfaces the encode error when the job failed, not a catalog miss", () => {
    const shown = playerErrorForFailedJob({ jobStatus: "failed", jobError: capture251 });
    assert.match(shown ?? "", /could not start/i);
    assert.doesNotMatch(shown ?? "", /catalog never loaded/i);
    assert.match(humanizeJobError(capture251) ?? "", /Cloud playout or Browser/);
    const verdict = classifyMoqEndVerdict({
      firstFrame: false,
      framesRendered: 0,
      videoTimeSec: 0,
      catalogReady: false,
      encodeDurationSec: 60,
      jobStatus: "failed",
      jobError: capture251,
      namespace: "bench-896442c0",
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.error ?? "", /could not start/i);
    assert.doesNotMatch(verdict.error ?? "", /catalog never loaded/i);
    assert.match(
      noMediaFailMessage({
        catalogReady: false,
        namespace: "bench-896442c0",
        jobStatus: "failed",
        jobError: capture251,
      }),
      /could not start/i,
    );
  });
});

describe("cmafSubscribeOptions", () => {
  it("joins live CMAF with NextGroupStart and no open-group FETCH", () => {
    const opts = cmafSubscribeOptions();
    assert.equal(opts.subscriptionFilter.type, "NextGroupStart");
    assert.equal(opts.warmStartCurrentGroup, false);
    assert.equal(opts.lateFrameThresholdMs, CMAF_LATE_FRAME_THRESHOLD_MS);
  });
});

describe("moqRenderSink", () => {
  it("keeps CMAF on the <video> element even when playa reports unknown", () => {
    assert.equal(moqRenderSink("cmaf"), "video");
    assert.equal(moqRenderSink("loc"), "canvas");
  });
});

describe("classifyCmafPlayheadStall", () => {
  const base = {
    videoTimeSec: 2.97,
    aheadSec: 0.53,
    frozenMs: 1_800,
    earlyWindow: true,
    sessionRestarts: 0,
    stallLimitMs: 1_750,
    retrying: false,
  };

  it("holds the prod BBB case: 2.97s playhead + 0.53s buffer during early join", () => {
    assert.equal(classifyCmafPlayheadStall(base), "hold");
  });

  it("does not restart a reconnect that reset the playhead to 0", () => {
    assert.equal(
      classifyCmafPlayheadStall({
        ...base,
        videoTimeSec: 0,
        aheadSec: 0,
        sessionRestarts: 1,
      }),
      "hold",
    );
  });

  it("holds a buffered freeze after the early window (keep the catalog)", () => {
    assert.equal(
      classifyCmafPlayheadStall({
        ...base,
        earlyWindow: false,
        frozenMs: 8_500,
        stallLimitMs: 8_000,
        videoTimeSec: 12.4,
        aheadSec: 0.8,
      }),
      "hold",
    );
  });

  it("is ok while the playhead is still inside the stall limit", () => {
    assert.equal(classifyCmafPlayheadStall({ ...base, frozenMs: 1_000 }), "ok");
  });

  it("is ok while a reconnect is in flight", () => {
    assert.equal(classifyCmafPlayheadStall({ ...base, aheadSec: 0, retrying: true }), "ok");
  });

  it("restarts a mid-run starve after the early window, then gives up", () => {
    const starved = {
      ...base,
      earlyWindow: false,
      aheadSec: 0,
      frozenMs: 8_500,
      stallLimitMs: 8_000,
      videoTimeSec: 20,
    };
    assert.equal(classifyCmafPlayheadStall(starved), "restart");
    assert.equal(classifyCmafPlayheadStall({ ...starved, sessionRestarts: 3 }), "give_up");
  });
});
