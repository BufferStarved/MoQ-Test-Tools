/**
 * Capture-timestamp vs media-timeline, path delay, and freeze-runaway averages.
 */
import assert from "node:assert/strict";

const E2E_MIN_MS = 8;
const E2E_MAX_MS = 30_000;

function isPlausibleE2eMs(value) {
  return value != null && Number.isFinite(value) && value >= E2E_MIN_MS && value < E2E_MAX_MS;
}

function captureTimestampLatencyMs(captureTimestampUs, nowMs) {
  if (!Number.isFinite(captureTimestampUs) || captureTimestampUs <= 0) {
    return undefined;
  }
  const captureMs = captureTimestampUs / 1000;
  if (captureMs < 1e12) {
    return undefined;
  }
  const latency = nowMs - captureMs;
  return isPlausibleE2eMs(latency) ? Math.round(latency) : undefined;
}

function pathDelayMs({ encodeLagMs = 0, rttMs = 0, playerBufferMs = 0, decodeMs = 0 }) {
  const total = Math.max(0, encodeLagMs) + Math.max(0, rttMs / 2) + Math.max(0, playerBufferMs) + Math.max(0, decodeMs);
  return isPlausibleE2eMs(total) ? Math.round(total) : undefined;
}

function robustE2eStats(values) {
  const filtered = values.filter(isPlausibleE2eMs).sort((a, b) => a - b);
  if (filtered.length === 0) {
    return null;
  }
  const mid = Math.floor(filtered.length / 2);
  const median =
    filtered.length % 2 === 1 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2;
  const cap = Math.max(median * 3, 5000);
  const healthy = filtered.filter((value) => value <= cap);
  const pool = healthy.length ? healthy : filtered;
  const avg = pool.reduce((sum, value) => sum + value, 0) / pool.length;
  return { avg, max: pool[pool.length - 1] };
}

const now = 1_700_000_000_000;
assert.equal(captureTimestampLatencyMs(5_000_000, now), undefined, "WebCodecs PTS is not Unix epoch");
assert.equal(captureTimestampLatencyMs(now * 1000 - 180_000, now), 180);
assert.equal(pathDelayMs({ encodeLagMs: 12, rttMs: 40, playerBufferMs: 25 }), 12 + 20 + 25);

const runaway = robustE2eStats([0, 2900, 3100, 3300, 16000, 17000]);
assert.ok(runaway);
assert.ok(runaway.avg < 4000, "freeze-runaway 16s samples must not dominate the average");
assert.equal(runaway.max, 3300);

console.log("unit-glass-latency: PASS");
