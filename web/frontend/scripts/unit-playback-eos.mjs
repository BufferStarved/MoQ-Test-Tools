/**
 * Publisher-stop must not look like a player crash after a successful run.
 */
import assert from "node:assert/strict";

function encodeLooksFinished({ jobStatus, benchmarkLoading } = {}) {
  if (jobStatus === "completed" || jobStatus === "failed") return true;
  if (jobStatus === "running" || jobStatus === "queued") return false;
  return benchmarkLoading === false;
}

function playedMostOfClip({ videoTimeSec = 0, encodeDurationSec = 0 } = {}) {
  return encodeDurationSec > 0 && videoTimeSec >= encodeDurationSec * 0.8;
}

function isGracefulMpegTsEos({
  playedOk,
  jobStatus,
  benchmarkLoading,
  videoTimeSec = 0,
  encodeDurationSec = 0,
  runStopped = false,
}) {
  if (!playedOk) return false;
  if (runStopped) return true;
  return (
    encodeLooksFinished({ jobStatus, benchmarkLoading }) ||
    playedMostOfClip({ videoTimeSec, encodeDurationSec })
  );
}

function isGracefulMoqReset({
  playedOk,
  code,
  message = "",
  jobStatus,
  benchmarkLoading,
  videoTimeSec = 0,
  encodeDurationSec = 0,
}) {
  if (!playedOk) return false;
  const reset = code === 4096 || /RESET_STREAM|stream reset|connection clos/i.test(message);
  if (!reset) return false;
  return (
    encodeLooksFinished({ jobStatus, benchmarkLoading }) ||
    playedMostOfClip({ videoTimeSec, encodeDurationSec })
  );
}

function isGracefulWhepDisconnect({
  playedOk,
  iceState,
  jobStatus,
  benchmarkLoading,
  videoTimeSec = 0,
  encodeDurationSec = 0,
}) {
  if (!playedOk) return false;
  const state = String(iceState || "").toLowerCase();
  if (!["failed", "disconnected", "closed"].includes(state)) return false;
  return (
    encodeLooksFinished({ jobStatus, benchmarkLoading }) ||
    playedMostOfClip({ videoTimeSec, encodeDurationSec })
  );
}

function unwrapFastApiDetail(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      if (typeof parsed?.detail === "string" && parsed.detail) {
        const prefix = trimmed.slice(0, jsonStart).trim().replace(/[:\s]+$/, "");
        return prefix ? `${prefix}: ${parsed.detail}` : parsed.detail;
      }
    } catch {
      /* ignore */
    }
  }
  return trimmed;
}

assert.equal(isGracefulMpegTsEos({ playedOk: true, jobStatus: "completed" }), true);
assert.equal(isGracefulMpegTsEos({ playedOk: true, jobStatus: "running", videoTimeSec: 55, encodeDurationSec: 60 }), true);
assert.equal(isGracefulMpegTsEos({ playedOk: true, jobStatus: "running", benchmarkLoading: false, videoTimeSec: 2, encodeDurationSec: 60 }), false);
assert.equal(isGracefulMpegTsEos({ playedOk: false, jobStatus: "completed" }), false);
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
  isGracefulMoqReset({
    playedOk: true,
    code: 4096,
    message: "Received RESET_STREAM.",
    jobStatus: "completed",
  }),
  true,
);
assert.equal(
  isGracefulMoqReset({
    playedOk: true,
    code: 4096,
    message: "Received RESET_STREAM.",
    benchmarkLoading: false,
  }),
  true,
);
assert.equal(
  isGracefulMoqReset({
    playedOk: true,
    code: 4096,
    message: "Received RESET_STREAM.",
    videoTimeSec: 55,
    encodeDurationSec: 60,
  }),
  true,
);
assert.equal(
  isGracefulMoqReset({
    playedOk: true,
    code: 4096,
    message: "Received RESET_STREAM.",
    jobStatus: "running",
    benchmarkLoading: true,
    videoTimeSec: 2,
    encodeDurationSec: 60,
  }),
  false,
);
assert.equal(
  isGracefulMoqReset({ playedOk: false, code: 4096, message: "Received RESET_STREAM." }),
  false,
);

assert.equal(
  isGracefulWhepDisconnect({
    playedOk: true,
    iceState: "disconnected",
    jobStatus: "completed",
  }),
  true,
);
assert.equal(
  isGracefulWhepDisconnect({
    playedOk: true,
    iceState: "failed",
    jobStatus: "running",
    benchmarkLoading: true,
  }),
  false,
);
assert.equal(
  isGracefulWhepDisconnect({
    playedOk: true,
    iceState: "closed",
    jobStatus: "running",
    videoTimeSec: 50,
    encodeDurationSec: 60,
  }),
  true,
);

assert.equal(unwrapFastApiDetail('{"detail":"Invalid token"}'), "Invalid token");
assert.equal(
  unwrapFastApiDetail('WHEP HTTP 401: {"detail":"Invalid token"}'),
  "WHEP HTTP 401: Invalid token",
);
assert.equal(unwrapFastApiDetail("plain error"), "plain error");

console.log("unit-playback-eos: PASS");
