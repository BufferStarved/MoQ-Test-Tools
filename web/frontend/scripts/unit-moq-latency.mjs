/**
 * MoQ latency must not inherit the HLS/SRT 2s floor.
 */
import assert from "node:assert/strict";

const SRT_MIN_TARGET_LATENCY_MS = 2000;
const DEFAULT_MOQ_TARGET_LATENCY_MS = 400;
const MOQ_GOP_SEC_MIN = 0.5;
const MOQ_GOP_SEC_MAX = 1.0;
const ASSUMED_FPS = 30;

function clampTargetLatencyMs(value) {
  return Math.max(100, Math.min(10_000, Math.round(value)));
}

function moqPlayerTargetLatencyMs(targetLatencyMs) {
  const ms = clampTargetLatencyMs(targetLatencyMs ?? DEFAULT_MOQ_TARGET_LATENCY_MS);
  if (ms >= SRT_MIN_TARGET_LATENCY_MS) {
    return DEFAULT_MOQ_TARGET_LATENCY_MS;
  }
  return ms;
}

function moqGopFramesForLatency(targetLatencyMs, fps = ASSUMED_FPS) {
  const ms = clampTargetLatencyMs(targetLatencyMs);
  const seconds = Math.min(MOQ_GOP_SEC_MAX, Math.max(MOQ_GOP_SEC_MIN, ms / 2000));
  return Math.max(1, Math.round(seconds * fps));
}

assert.equal(moqPlayerTargetLatencyMs(2000), 400);
assert.equal(moqPlayerTargetLatencyMs(400), 400);
assert.equal(moqGopFramesForLatency(400), 15);
assert.equal(moqGopFramesForLatency(2000), 30);

console.log("unit-moq-latency: PASS");
