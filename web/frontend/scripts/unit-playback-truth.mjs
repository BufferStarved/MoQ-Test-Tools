/**
 * Browser MoQ LOC must not report 0 drops / 20ms e2e while the canvas is dead.
 * Ground truth: comparison (17).csv — 42 painted frames, 0 reported drops,
 * playhead stuck at 1.4s, e2e ~20ms vs WebRTC ~170ms.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRAME_STALL_MS = 800;
const STALL_E2E_MAX_MS = 180_000;
const DEFAULT_PLAYBACK_FPS = 30;

function inferDroppedFrames({
  framesRendered,
  reportedDropped = 0,
  firstFrameAtMs,
  nowMs = Date.now(),
  targetFps = DEFAULT_PLAYBACK_FPS,
}) {
  const reported = Math.max(0, Math.floor(reportedDropped));
  const rendered = Math.max(0, Math.floor(framesRendered));
  if (firstFrameAtMs <= 0 || rendered <= 0) return reported;
  const elapsedSec = (nowMs - firstFrameAtMs) / 1000;
  if (elapsedSec < 0.45) return reported;
  const fps = targetFps > 1 && targetFps < 120 ? targetFps : DEFAULT_PLAYBACK_FPS;
  const expected = Math.round(fps * elapsedSec);
  return Math.max(reported, Math.max(0, expected - rendered));
}

function locGlassDelayMs({
  playerLatencyMs,
  lastFrameAtMs = 0,
  nowMs = Date.now(),
  bridgeMs = 0,
  encodeLagMs = 0,
  rttMs = 0,
  bufferMs = 0,
}) {
  const stallMs = lastFrameAtMs > 0 ? Math.max(0, nowMs - lastFrameAtMs) : 0;
  const frozen = stallMs >= FRAME_STALL_MS;
  let base;
  if (playerLatencyMs != null && Number.isFinite(playerLatencyMs) && playerLatencyMs >= 8) {
    base = playerLatencyMs;
  } else {
    const path = Math.max(0, encodeLagMs) + Math.max(0, rttMs / 2) + Math.max(0, bufferMs);
    base = path >= 8 ? path : frozen ? 0 : undefined;
  }
  if (base == null) return undefined;
  const total = base + (frozen ? stallMs : 0) + Math.max(0, bridgeMs);
  if (!Number.isFinite(total) || total < 8 || total >= STALL_E2E_MAX_MS) return undefined;
  return Math.round(total);
}

assert.equal(
  inferDroppedFrames({
    framesRendered: 42,
    reportedDropped: 0,
    firstFrameAtMs: 1_000,
    nowMs: 1_000 + 41_000,
    targetFps: 30,
  }),
  30 * 41 - 42,
  "comparison(17): ~42 painted over ~41s at 30fps is over a thousand missed frames, not 0",
);

assert.equal(
  inferDroppedFrames({
    framesRendered: 1256,
    reportedDropped: 457,
    firstFrameAtMs: 2_200,
    nowMs: 2_200 + 42_000,
    targetFps: 30,
  }),
  457,
  "WebRTC HTML/RTC drops win when they exceed the fps inference",
);

assert.equal(
  locGlassDelayMs({ playerLatencyMs: 24, lastFrameAtMs: 5_000, nowMs: 5_200 }),
  24,
);
const frozen = locGlassDelayMs({
  playerLatencyMs: 24,
  lastFrameAtMs: 5_000,
  nowMs: 5_000 + 36_000,
});
assert.ok(frozen > 30_000, `stale canvas must not stay at 24ms, got ${frozen}`);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const truth = fs.readFileSync(path.join(root, "playbackTruth.ts"), "utf8");
assert.match(truth, /export function inferDroppedFrames/);
assert.match(truth, /export function locGlassDelayMs/);
const moq = fs.readFileSync(path.join(root, "players/MoqPlayer.tsx"), "utf8");
assert.match(moq, /inferDroppedFrames/);
assert.match(moq, /lastFrameAtMs/);
assert.match(moq, /resetLocPlaybackPipeline/);
assert.match(moq, /requestLocIdr/);
const charts = fs.readFileSync(path.join(root, "ComparisonCharts.tsx"), "utf8");
assert.match(charts, /playa reports 0/);
assert.match(charts, /stale frame aging/);
const glass = fs.readFileSync(path.join(root, "glassLatency.ts"), "utf8");
assert.match(glass, /mediaPackaging === "loc"/);
assert.match(glass, /locGlassDelayMs/);

for (const testFile of ["playbackTruth.test.ts", "glassLatency.test.ts", "moqLocPlayback.test.ts"]) {
  const unit = spawnSync(
    process.execPath,
    ["--test", "--experimental-strip-types", path.join(root, testFile)],
    { encoding: "utf8" },
  );
  assert.equal(unit.status, 0, `${testFile}: ${unit.stderr || unit.stdout}`);
}

console.log("unit-playback-truth: PASS");
