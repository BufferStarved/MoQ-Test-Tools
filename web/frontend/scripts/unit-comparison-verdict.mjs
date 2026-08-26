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

function rankLowerIsBetter(values) {
  const numeric = [];
  values.forEach((value, index) => {
    if (finitePositive(value)) numeric.push({ index, value });
  });
  if (numeric.length < 2) {
    return { bestIndex: null, deltaVsBest: values.map(() => null) };
  }
  let bestIndex = numeric[0].index;
  let bestValue = numeric[0].value;
  for (const item of numeric) {
    if (item.value < bestValue) {
      bestIndex = item.index;
      bestValue = item.value;
    }
  }
  return {
    bestIndex,
    deltaVsBest: values.map((value, index) =>
      index === bestIndex || !finitePositive(value) ? null : Math.round(value - bestValue),
    ),
  };
}

const compared = rankLowerIsBetter([45, 120, null]);
assert.equal(compared.bestIndex, 0);
assert.deepEqual(compared.deltaVsBest, [null, 75, null]);
assert.equal(rankLowerIsBetter([45, null]).bestIndex, null);

console.log("unit-comparison-verdict: PASS");
