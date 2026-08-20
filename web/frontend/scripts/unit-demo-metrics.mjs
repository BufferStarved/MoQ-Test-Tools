/**
 * Demo-critical Results-tab intuition: stop ≠ stall, VMAF gated,
 * TTFF is an event, dropped frames are charted, LOC e2e does not
 * grow with media time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

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

function playbackCoveredEncode(options) {
  const duration = encodeDurationForEndVerdict(options);
  const vt = options.videoTimeSec ?? 0;
  if (!(duration > 0)) return true;
  return vt >= duration * 0.8;
}

assert.equal(
  playbackCoveredEncode({
    videoTimeSec: 18.8,
    encodeDurationSec: 300,
    encodeElapsedSec: 20,
    runStopped: true,
  }),
  true,
  "operator stop at ~20s of a 300s cap is not a stall",
);
assert.equal(
  playbackCoveredEncode({
    videoTimeSec: 11.2,
    encodeDurationSec: 60,
    encodeElapsedSec: 60,
  }),
  false,
  "mid-run stall against a finished encode is still a failure",
);
assert.equal(
  playbackCoveredEncode({
    videoTimeSec: 24.6,
    encodeDurationSec: 300,
    encodeElapsedSec: 62,
    runStopped: true,
  }),
  false,
  "real freeze on a ~62s stopped encode is still a stall",
);
function stallCopy({ videoTimeSec, encodeDurationSec, encodeElapsedSec, runStopped }) {
  const duration = encodeDurationForEndVerdict({
    encodeDurationSec,
    encodeElapsedSec,
    runStopped,
  });
  return `WebRTC playback stalled at ${videoTimeSec.toFixed(1)}s of a ${duration}s encode.`;
}
assert.match(
  stallCopy({
    videoTimeSec: 24.6,
    encodeDurationSec: 300,
    encodeElapsedSec: 62,
    runStopped: true,
  }),
  /24\.6s of a 62s encode/,
);
assert.doesNotMatch(
  stallCopy({
    videoTimeSec: 24.6,
    encodeDurationSec: 300,
    encodeElapsedSec: 62,
    runStopped: true,
  }),
  /300s/,
);

function browserEncodeLagMs({
  captureTimestampUs,
  encodedAtMs,
  encodeQueueSize = 0,
  fps = 30,
}) {
  const captureMs = captureTimestampUs / 1000;
  const captureLag = captureMs > 0 ? Math.max(0, encodedAtMs - captureMs) : 0;
  const queueLag = Math.max(0, encodeQueueSize) * (1000 / fps);
  return Math.round(Math.min(30_000, Math.max(captureLag, queueLag)));
}

const now = 1_700_000_000_000;
assert.equal(
  browserEncodeLagMs({
    captureTimestampUs: (now - 12) * 1000,
    encodedAtMs: now,
    encodeQueueSize: 0,
  }),
  12,
);
assert.ok(
  browserEncodeLagMs({
    captureTimestampUs: 33_333,
    encodedAtMs: now,
  }) === 30_000,
  "WebCodecs PTS must not become a multi-day encode lag",
);

function isRealVmafLeg(leg) {
  if (!leg || leg.vmaf_score == null || !Number.isFinite(leg.vmaf_score)) return false;
  const on = (leg.computed_on || "").toLowerCase();
  return on !== "webrtc_qp" && on !== "disabled";
}
assert.equal(isRealVmafLeg({ vmaf_score: 88, computed_on: "webrtc_qp" }), false);
assert.equal(isRealVmafLeg({ vmaf_score: 91, computed_on: "libvmaf" }), true);

const charts = fs.readFileSync(path.join(root, "ComparisonCharts.tsx"), "utf8");
assert.match(charts, /Time to first frame is a single join event/);
assert.doesNotMatch(
  charts,
  /title="Time to first frame"[\s\S]*metricKey="playback_ttff_ms"/,
);
assert.match(charts, /metricKey="playback_frames_dropped"/);
assert.match(charts, /metricKey="playback_fps"/);
assert.match(charts, /qualityRequested && comparisonHasMetric\(points, "vmaf_score_encoder"/);
assert.match(charts, /Playhead \(seconds of media on glass\)/);
assert.match(charts, /jitterBufferDelay/);
assert.match(charts, /playa reports 0/);
assert.match(charts, /stale frame aging/);

const whep = fs.readFileSync(path.join(root, "players/WhepPlayer.tsx"), "utf8");
assert.match(whep, /whepPlaybackBufferSec/);

const moqPlayer = fs.readFileSync(path.join(root, "players/MoqPlayer.tsx"), "utf8");
assert.match(moqPlayer, /catalog_timeout_skipped waiting_for_announce/);
assert.match(moqPlayer, /session_restart_skipped encode_over/);
assert.match(moqPlayer, /moqPlaybackSucceeded\(jobId\)/);

const gate = fs.readFileSync(path.join(root, "playbackGate.ts"), "utf8");
assert.match(gate, /if \(protocol === "moq"\) \{\s*return "live";/s);

const whip = fs.readFileSync(path.join(root, "browserMoq/whipPublisher.ts"), "utf8");
assert.doesNotMatch(whip, /vmaf_score:\s*qpQuality/);
assert.doesNotMatch(whip, /H\.264 QP 0–51/);

const encoder = fs.readFileSync(path.join(root, "browserMoq/encoder.ts"), "utf8");
assert.match(encoder, /export function browserEncodeLagMs/);
assert.doesNotMatch(encoder, /wallMs - mediaMs/);

const glass = fs.readFileSync(path.join(root, "glassLatency.ts"), "utf8");
assert.match(glass, /locGlassDelayMs/);
assert.match(glass, /Do not use playheadAnchored here/);

console.log("unit-demo-metrics: PASS");
