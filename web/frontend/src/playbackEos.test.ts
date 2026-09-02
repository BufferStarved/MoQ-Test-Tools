import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isGracefulMpegTsEos,
  isGracefulMoqEncodeOver,
  isGracefulMoqReset,
  isGracefulPlaybackEnd,
  isGracefulWhepDisconnect,
  playedMostOfEncode,
} from "./playbackEos.ts";

describe("playedMostOfEncode", () => {
  it("requires 80% of the published clip", () => {
    assert.equal(playedMostOfEncode({ videoTimeSec: 12.4, encodeDurationSec: 60 }), false);
    assert.equal(playedMostOfEncode({ videoTimeSec: 48, encodeDurationSec: 60 }), true);
    assert.equal(playedMostOfEncode({ videoTimeSec: 12.4, encodeDurationSec: 0 }), false);
  });
});

describe("isGracefulMpegTsEos", () => {
  it("treats operator Stop after paint as graceful even when currentTime lags", () => {
    assert.equal(
      isGracefulMpegTsEos({
        playedOk: true,
        runStopped: true,
        jobStatus: "running",
        videoTimeSec: 21.2,
        encodeDurationSec: 81,
      }),
      true,
    );
    assert.equal(
      isGracefulMpegTsEos({
        playedOk: true,
        jobStatus: "running",
        videoTimeSec: 21.2,
        encodeDurationSec: 81,
      }),
      false,
    );
  });
});

describe("isGracefulPlaybackEnd", () => {
  it("treats completed encode-over after paint as graceful when the comparison is idle", () => {
    assert.equal(
      isGracefulPlaybackEnd({
        playedOk: true,
        jobStatus: "completed",
        benchmarkLoading: false,
      }),
      true,
    );
    assert.equal(
      isGracefulPlaybackEnd({
        playedOk: true,
        jobStatus: "completed",
        benchmarkLoading: true,
      }),
      false,
    );
  });
});

describe("isGracefulMoqEncodeOver", () => {
  it("is encode-over after paint when the job completed", () => {
    assert.equal(
      isGracefulMoqEncodeOver({ playedOk: true, jobStatus: "completed" }),
      true,
    );
    assert.equal(
      isGracefulMoqEncodeOver({ playedOk: true, runStopped: true }),
      true,
    );
  });

  it("is not encode-over before first frame or while the job is live", () => {
    assert.equal(
      isGracefulMoqEncodeOver({ playedOk: false, jobStatus: "completed" }),
      false,
    );
    assert.equal(
      isGracefulMoqEncodeOver({ playedOk: true, jobStatus: "running" }),
      false,
    );
  });
});

describe("isGracefulMoqReset", () => {
  const reset = { playedOk: true, code: 4096, message: "RESET_STREAM" };

  it("is not graceful when the playhead froze mid-clip even if the job completed", () => {
    assert.equal(
      isGracefulMoqReset({
        ...reset,
        jobStatus: "completed",
        benchmarkLoading: false,
        videoTimeSec: 12.43,
        encodeDurationSec: 60,
      }),
      false,
    );
  });

  it("is graceful only after most of the encode played", () => {
    assert.equal(
      isGracefulMoqReset({
        ...reset,
        jobStatus: "completed",
        videoTimeSec: 55,
        encodeDurationSec: 60,
      }),
      true,
    );
  });

  it("rejects connection-close wording unless the clip was covered", () => {
    assert.equal(
      isGracefulMoqReset({
        playedOk: true,
        message: "WebTransport connection closed",
        jobStatus: "completed",
        videoTimeSec: 8.8,
        encodeDurationSec: 60,
      }),
      false,
    );
  });

  it("never treats a reset before first frame as EOS", () => {
    assert.equal(
      isGracefulMoqReset({
        playedOk: false,
        code: 4096,
        jobStatus: "completed",
        videoTimeSec: 0,
        encodeDurationSec: 60,
      }),
      false,
    );
  });
});

describe("isGracefulWhepDisconnect", () => {
  it("does not treat ICE close after a short play as success", () => {
    assert.equal(
      isGracefulWhepDisconnect({
        playedOk: true,
        iceState: "closed",
        jobStatus: "completed",
        videoTimeSec: 10,
        encodeDurationSec: 60,
      }),
      false,
    );
  });

  it("treats operator Stop after paint as graceful even when currentTime lags", () => {
    assert.equal(
      isGracefulWhepDisconnect({
        playedOk: true,
        iceState: "closed",
        runStopped: true,
        videoTimeSec: 24.7,
        encodeDurationSec: 36,
        encodeElapsedSec: 36,
      }),
      true,
    );
  });
});
