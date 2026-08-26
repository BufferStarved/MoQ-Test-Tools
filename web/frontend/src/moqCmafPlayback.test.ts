import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyCmafPlayheadStall,
  classifyMoqEndVerdict,
  cmafSubscribeOptions,
  moqLiveEdgePolicy,
  CMAF_HEALTHY_HOLD_CEILING_SEC,
  CMAF_HEALTHY_HOLD_FLOOR_SEC,
  CMAF_STARVE_HOLD_SEC,
  humanizeJobError,
  isCaptureOrPublishError,
  isPlayableCatalogReady,
  isPublisherNotReadyError,
  moqHasRenderedMedia,
  moqRenderSink,
  noMediaFailMessage,
  noMediaTimeoutMs,
  playerErrorForFailedJob,
  playaLatencyForMoqE2e,
  isTransientMoqSessionDrop,
  shouldSkipMoqSessionRestart,
  MOQ_CONNECTION_LOST,
  shouldFailNoMediaWatchdog,
  shouldKeepSessionOnSubscribeError,
  CMAF_LATE_FRAME_THRESHOLD_MS,
  MOQ_ALL_TRACKS_REFUSED,
  MOQ_CATALOG_REFRESH_WAIT_MS,
  MOQ_NO_MEDIA_TIMEOUT_MS,
  MOQ_SUBSCRIPTION_REFUSED,
} from "./moqCmafPlayback.ts";

describe("moqLiveEdgePolicy", () => {
  it("chases a WebRTC-class hold when the playhead is healthy", () => {
    const policy = moqLiveEdgePolicy(400);
    assert.equal(policy.holdBehindSec, CMAF_HEALTHY_HOLD_CEILING_SEC);
    assert.ok(policy.holdBehindSec <= 0.4);
    assert.ok(policy.holdBehindSec >= CMAF_HEALTHY_HOLD_FLOOR_SEC);
    assert.equal(policy.starveHoldSec, CMAF_STARVE_HOLD_SEC);
    assert.ok(policy.rateOnSec < 1, "must start catch-up well before a 1s HLS-like lead");
    assert.ok(policy.seekThresholdSec < 4, "30s floor never trimmed a 6–10s balloon");
    assert.ok(policy.catchUpSpanSec <= 2, "max rate must arrive before a 6s MSE balloon");
  });

  it("does not inherit a 2s HLS-style hold as the MoQ live target", () => {
    const policy = moqLiveEdgePolicy(2000);
    assert.equal(policy.holdBehindSec, CMAF_HEALTHY_HOLD_CEILING_SEC);
    assert.ok(policy.rateOnSec < 1);
    assert.ok(policy.seekThresholdSec < 4);
    assert.ok(policy.starveHoldSec >= 1.0, "late-IDR starve hold stays the larger cushion");
  });
});

describe("isPlayableCatalogReady", () => {
  it("does not treat catalog ready with 0 video levels as success", () => {
    assert.equal(isPlayableCatalogReady({ catalogReady: true, videoLevels: 0 }), false);
    assert.equal(isPlayableCatalogReady({ catalogReady: true }), false);
    assert.equal(isPlayableCatalogReady({ videoLevels: 1 }), false);
  });

  it("requires both a ready catalog and at least one selected video level", () => {
    assert.equal(isPlayableCatalogReady({ catalogReady: true, videoLevels: 1 }), true);
  });
});

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

  it("does not call a late drain/reconnect a never-rendered failure", () => {
    const verdict = classifyMoqEndVerdict({
      firstFrame: true,
      framesRendered: 1692,
      videoTimeSec: 56.2,
      catalogReady: true,
      encodeDurationSec: 60,
      encodeElapsedSec: 59,
      lastError: "MoQ catalog loaded but no video frames rendered. Encode-only success is a player failure.",
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
  });

  it("does not treat operator stop as a stall against the unused 300s cap", () => {
    const verdict = classifyMoqEndVerdict({
      firstFrame: true,
      framesRendered: 500,
      videoTimeSec: 18.8,
      encodeDurationSec: 300,
      encodeElapsedSec: 20,
      runStopped: true,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
  });

  it("does not treat encode-over playhead_frozen after paint as a failure", () => {
    const verdict = classifyMoqEndVerdict({
      firstFrame: true,
      framesRendered: 1200,
      videoTimeSec: 42.31,
      catalogReady: true,
      encodeDurationSec: 53,
      encodeElapsedSec: 53,
      jobStatus: "completed",
      lastError: "MoQ playback stalled at 42.3s of a 53s encode.",
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.error, null);
    assert.equal(verdict.status, "Encode ended");
    assert.doesNotMatch(verdict.status, /Failed/i);
  });
});

describe("noMediaFailMessage", () => {
  it("names the namespace so a 0x10 miss is diagnosable", () => {
    assert.match(noMediaFailMessage({ catalogReady: false, namespace: "bench-6a9355b9" }), /bench-6a9355b9/);
  });

  it("does not call encode-only success a 0x10 miss", () => {
    const message = noMediaFailMessage({
      catalogReady: false,
      namespace: "bench-733f1d7c",
      jobStatus: "completed",
    });
    assert.match(message, /never announced namespace bench-733f1d7c/i);
    assert.doesNotMatch(message, /0x10 subscribe miss is not OK/);
  });

  it("does not wrap catalog-not-live as publisher never started", () => {
    const jobError =
      "MoQ publisher never announced namespace bench-b565262f on the relay. Encode produced CMAF but the catalog is not live.";
    const message = noMediaFailMessage({
      catalogReady: false,
      namespace: "bench-b565262f",
      jobStatus: "failed",
      jobError,
    });
    assert.match(message, /catalog is not live/i);
    assert.doesNotMatch(message, /publisher never started/i);
  });

  it("says the publisher ran when WebTransport never connected", () => {
    const jobError =
      "The publisher ran but did not connect to the relay (WebTransport session never connected; no connection_id). relay=https://34-28-164-90.sslip.io:4433/moq-relay binary=openmoq-publisher draft=16.";
    const message = noMediaFailMessage({
      catalogReady: false,
      namespace: "bench-b565262f",
      jobStatus: "failed",
      jobError,
    });
    assert.match(message, /did not connect to the relay/i);
    assert.doesNotMatch(message, /publisher never started/i);
  });

  it("names a one-shot catalog miss when ingest already announced", () => {
    const message = noMediaFailMessage({
      catalogReady: false,
      namespace: "bench-bbc4eb3c",
      jobStatus: "running",
      previewReady: true,
    });
    assert.match(message, /bench-bbc4eb3c/);
    assert.match(message, /catalog object never reached this player/i);
    assert.doesNotMatch(message, /0x10 subscribe miss is not OK/);
  });
});

describe("shouldFailNoMediaWatchdog", () => {
  it("does not fail while the job is queued or the publisher is not live", () => {
    assert.equal(
      shouldFailNoMediaWatchdog({
        jobStatus: "queued",
        previewReady: false,
        liveMs: 20_000,
        deadlineMs: 15_000,
      }),
      false,
    );
    assert.equal(
      shouldFailNoMediaWatchdog({
        jobStatus: "running",
        previewReady: false,
        liveMs: 20_000,
        deadlineMs: 15_000,
      }),
      false,
    );
  });

  it("fails after encode ends or after a live publisher misses the deadline", () => {
    assert.equal(
      shouldFailNoMediaWatchdog({
        jobStatus: "completed",
        previewReady: false,
        liveMs: 1_000,
        deadlineMs: 15_000,
      }),
      true,
    );
    assert.equal(
      shouldFailNoMediaWatchdog({
        jobStatus: "running",
        previewReady: true,
        catalogReady: true,
        liveMs: 16_000,
        deadlineMs: 15_000,
      }),
      true,
    );
  });

  it("does not call a live empty catalog a one-shot miss while encode is still running", () => {
    assert.equal(
      shouldFailNoMediaWatchdog({
        jobStatus: "running",
        previewReady: true,
        catalogReady: false,
        liveMs: 16_000,
        deadlineMs: 15_000,
      }),
      false,
    );
    assert.equal(
      shouldFailNoMediaWatchdog({
        jobStatus: "running",
        previewReady: true,
        catalogReady: false,
        liveMs: MOQ_CATALOG_REFRESH_WAIT_MS + 1,
        deadlineMs: 15_000,
      }),
      false,
    );
    assert.equal(
      shouldFailNoMediaWatchdog({
        jobStatus: "completed",
        previewReady: true,
        catalogReady: false,
        liveMs: 1_000,
        deadlineMs: 15_000,
      }),
      true,
    );
  });
});

describe("catalog miss is not publisher-never-started", () => {
  const catalogNotLive =
    "MoQ publisher never announced namespace bench-de7b38dd on the relay. Encode produced CMAF but the catalog is not live.";
  const oneShot =
    "MoQ namespace bench-de7b38dd is live on the relay but the catalog object never reached this player (one-shot catalog miss).";

  it("does not humanize catalog-not-live or one-shot miss as publisher never started", () => {
    assert.doesNotMatch(humanizeJobError(catalogNotLive) ?? "", /publisher never started/i);
    assert.match(humanizeJobError(catalogNotLive) ?? "", /catalog is not live/i);
    assert.doesNotMatch(humanizeJobError(oneShot) ?? "", /publisher never started/i);
    assert.match(humanizeJobError(oneShot) ?? "", /catalog object never reached/i);
    assert.doesNotMatch(
      noMediaFailMessage({
        catalogReady: false,
        namespace: "bench-de7b38dd",
        jobStatus: "failed",
        jobError: catalogNotLive,
      }),
      /publisher never started/i,
    );
    assert.doesNotMatch(
      noMediaFailMessage({
        catalogReady: false,
        namespace: "bench-de7b38dd",
        jobStatus: "running",
        previewReady: true,
      }),
      /publisher never started/i,
    );
  });

  it("names OBS WebSocket I/O instead of publisher never started", () => {
    const obsEio =
      "OBS WebSocket I/O error ([Errno 5] Input/output error). Check Tools → WebSocket Server and that OBS is still running.";
    assert.equal(isCaptureOrPublishError(obsEio), true);
    assert.doesNotMatch(humanizeJobError(obsEio) ?? "", /publisher never started/i);
    assert.match(humanizeJobError(obsEio) ?? "", /OBS WebSocket I\/O/i);
  });

  it("never leaves last_error as a bare errno 5", () => {
    const shown = humanizeJobError("[Errno 5] Input/output error") ?? "";
    assert.doesNotMatch(shown, /catalog never loaded/i);
    assert.doesNotMatch(shown, /camera may be busy, or/i);
    assert.match(shown, /publisher pipe closed/i);
  });

  it("splits camera vs pipe vs moq5 exit", () => {
    assert.match(
      humanizeJobError("camera I/O error: [Errno 5] Input/output error. The camera may be busy") ?? "",
      /camera on this laptop could not start/i,
    );
    assert.match(
      humanizeJobError("ffmpeg I/O error: [Errno 5] Input/output error. The encoder wrote to a closed publisher pipe") ?? "",
      /publisher pipe closed/i,
    );
    assert.match(
      humanizeJobError("moq5 publisher exited with code 1 before WebTransport CONNECT: endpoint connect failed: -2") ?? "",
      /publisher exited before a live catalog/i,
    );
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

  it("surfaces a slot-cancel as a player error even if status stayed completed", () => {
    const shown = playerErrorForFailedJob({
      jobStatus: "completed",
      jobError: "Cancelled while waiting for a cloud encode slot",
    });
    assert.match(shown ?? "", /cancelled while waiting/i);
    assert.equal(
      playerErrorForFailedJob({ jobStatus: "completed", jobError: "encode finished" }),
      null,
    );
  });
});

describe("MoQ 4099 reconnect", () => {
  it("treats 4099 / Connection lost as a transient drop", () => {
    assert.equal(isTransientMoqSessionDrop({ code: MOQ_CONNECTION_LOST }), true);
    assert.equal(isTransientMoqSessionDrop({ message: "Connection lost" }), true);
    assert.equal(isTransientMoqSessionDrop({ code: 4096, message: "RESET_STREAM" }), false);
  });

  it("reconnects on 4099 after job=completed unless the playhead covered the clip", () => {
    assert.equal(
      shouldSkipMoqSessionRestart({
        firstFrame: true,
        videoTimeSec: 2,
        encodeDurationSec: 30,
      }),
      false,
    );
    assert.equal(
      shouldSkipMoqSessionRestart({
        firstFrame: true,
        videoTimeSec: 28,
        encodeDurationSec: 30,
      }),
      true,
    );
    assert.equal(shouldSkipMoqSessionRestart({ runStopped: true, firstFrame: true }), true);
    assert.equal(shouldSkipMoqSessionRestart({ firstFrame: false, videoTimeSec: 0 }), false);
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

describe("playaLatencyForMoqE2e", () => {
  it("keeps playa latencyMs on LOC only", () => {
    assert.equal(playaLatencyForMoqE2e("loc", 28), 28);
    assert.equal(playaLatencyForMoqE2e("cmaf", 4750), undefined);
    assert.equal(playaLatencyForMoqE2e("loc", 0), undefined);
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
