/**
 * WHEP end-of-run must keep the failure on screen. Mirrors
 * web/frontend/src/webrtcPlayback.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/webrtcPlayback.ts"),
  "utf8",
);
assert.match(src, /classifyWhepEndVerdict/);
assert.match(src, /no video frames/);
assert.match(src, /Encode-only success is a player or WHIP failure/);

const whepPlayer = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/players/WhepPlayer.tsx"),
  "utf8",
);
assert.match(whepPlayer, /classifyWhepEndVerdict/);
assert.match(whepPlayer, /whepHasRenderedMedia/);
assert.match(whepPlayer, /playbackGate === "ended"/);
assert.doesNotMatch(whepPlayer, /ttffMs > 0 \|\| sessionRef\.current\.maxVideoTime/);
assert.doesNotMatch(
  whepPlayer,
  /if \(playbackGate !== "live"\) \{\s*setError\(null\)/,
);

function whepHasRenderedMedia({ framesRendered = 0 } = {}) {
  return framesRendered >= 8;
}

function encodeDurationForEndVerdict({
  encodeDurationSec = 0,
  encodeElapsedSec = 0,
  runStopped = false,
} = {}) {
  const planned = Math.max(0, encodeDurationSec);
  const elapsed = Math.max(0, encodeElapsedSec);
  if (runStopped) return elapsed;
  if (planned > 0 && elapsed > 0 && elapsed < planned * 0.8) return elapsed;
  return planned;
}

function classifyWhepEndVerdict({
  framesRendered = 0,
  videoTimeSec = 0,
  lastError = null,
  encodeDurationSec = 0,
  encodeElapsedSec = 0,
  runStopped = false,
} = {}) {
  const played = whepHasRenderedMedia({ framesRendered });
  const duration = encodeDurationForEndVerdict({
    encodeDurationSec,
    encodeElapsedSec,
    runStopped,
  });
  const vt = videoTimeSec;
  const covered = duration > 0 && vt >= duration * 0.8;
  if (played && covered) return { ok: true, status: "Playback OK", error: null };
  if (played && !covered && duration > 0) {
    return {
      ok: false,
      status: "Failed (see diagnostics)",
      error: `WebRTC playback stalled at ${vt.toFixed(1)}s of a ${duration}s encode.`,
    };
  }
  if (played) return { ok: true, status: "Playback OK", error: null };
  return {
    ok: false,
    status: "Failed (see diagnostics)",
    error: lastError || "WebRTC/WHEP produced no video frames. Encode-only success is a player or WHIP failure.",
  };
}

const silentCsv = classifyWhepEndVerdict({
  framesRendered: 0,
  videoTimeSec: 11.198,
  lastError: "WHEP ICE failed. MediaMTX is not reachable from this browser.",
  encodeDurationSec: 60,
});
assert.equal(silentCsv.ok, false);
assert.match(silentCsv.error, /WHEP ICE failed/);

const oneFrame = classifyWhepEndVerdict({
  framesRendered: 1,
  videoTimeSec: 11.198,
  encodeDurationSec: 60,
});
assert.equal(oneFrame.ok, false);
assert.match(oneFrame.error, /no video frames/i);

const stalled = classifyWhepEndVerdict({
  framesRendered: 40,
  videoTimeSec: 11.2,
  encodeDurationSec: 60,
});
assert.equal(stalled.ok, false);
assert.match(stalled.error, /stalled at 11.2s/);

const ok = classifyWhepEndVerdict({
  framesRendered: 400,
  videoTimeSec: 50,
  encodeDurationSec: 60,
});
assert.equal(ok.ok, true);
assert.equal(ok.status, "Playback OK");

const stopped = classifyWhepEndVerdict({
  framesRendered: 400,
  videoTimeSec: 28.9,
  encodeDurationSec: 300,
  encodeElapsedSec: 30,
  runStopped: true,
});
assert.equal(stopped.ok, true, "Stop at 30s of a 300s cap is Playback OK");

const freezeStopped = classifyWhepEndVerdict({
  framesRendered: 400,
  videoTimeSec: 24.6,
  encodeDurationSec: 300,
  encodeElapsedSec: 62,
  runStopped: true,
});
assert.equal(freezeStopped.ok, false);
assert.match(freezeStopped.error, /stalled at 24\.6s of a 62s encode/);
assert.doesNotMatch(freezeStopped.error, /300s/);

assert.match(whepPlayer, /whepPlaybackBufferSec/);
assert.match(whepPlayer, /jitterBufferMs/);

console.log("unit-whep-end-verdict: PASS");
