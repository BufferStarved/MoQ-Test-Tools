/**
 * Verdict ranks glass delay across protocols once samples are in-band.
 */
import assert from "node:assert/strict";

function finitePositive(value) {
  return value != null && Number.isFinite(value) && value > 0;
}

function pickLowest(streams, read) {
  let best = null;
  streams.forEach((result, index) => {
    const value = read(result);
    if (!finitePositive(value)) {
      return;
    }
    if (!best || value < best.value) {
      best = { index, value };
    }
  });
  return best;
}

const streams = [
  { protocol: "moq", averages: { e2e_latency_ms: 180, playback_ttff_ms: 1200 } },
  { protocol: "webrtc", averages: { e2e_latency_ms: 45, playback_ttff_ms: 4 } },
];
const e2e = pickLowest(streams, (r) => r.averages.e2e_latency_ms);
assert.equal(e2e.index, 1);
assert.equal(e2e.value, 45);

console.log("unit-comparison-verdict: PASS");
