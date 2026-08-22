import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLatencyBudget,
  encodeFrameDropPct,
  encodeLatencyMs,
  frameDeliveryPct,
  latencyBudgetShares,
  networkLatencyMs,
  playbackFrameDropPct,
  playerBufferLatencyMs,
} from "./latencyBudget.ts";

test("encode component adds the hidden pipeline offset back exactly once", () => {
  // encode_lag_ms charts only growth past the startup offset; the offset is
  // still real glass delay, so the budget must carry it.
  assert.equal(encodeLatencyMs({ pipelineBaselineMs: 2000, encodeLagMs: 500 }), 2500);
  assert.equal(encodeLatencyMs({ pipelineBaselineMs: 2000, encodeLagMs: 0 }), 2000);
  assert.equal(encodeLatencyMs({}), 0);
});

test("network component is one-way, not RTT", () => {
  assert.equal(networkLatencyMs(80), 40);
  assert.equal(networkLatencyMs(0), 0);
  assert.equal(networkLatencyMs(null), 0);
});

test("player buffer converts seconds and rejects clock artifacts", () => {
  assert.equal(playerBufferLatencyMs(4), 4000);
  assert.equal(playerBufferLatencyMs(undefined), 0);
  assert.equal(playerBufferLatencyMs(99_999), 60_000);
});

test("residual exposes glass delay the components cannot explain", () => {
  // Zixi Fast HLS chunk packaging is unmeasured today — it has to surface as
  // unattributed rather than inflating another component.
  const budget = buildLatencyBudget({
    pipelineBaselineMs: 1500,
    uploadLatencyMs: 200,
    netRttMs: 60,
    playbackBufferSec: 4,
    e2eLatencyMs: 12_000,
  });
  assert.equal(budget.accountedMs, 1500 + 200 + 30 + 4000);
  assert.equal(budget.residualMs, 12_000 - budget.accountedMs);
});

test("no e2e measurement means nothing to attribute", () => {
  const budget = buildLatencyBudget({ pipelineBaselineMs: 1500 });
  assert.equal(budget.accountedMs, 1500);
  assert.equal(budget.residualMs, 0);
  assert.equal(latencyBudgetShares(budget), null);
});

test("over-counting clamps instead of rendering a negative stage", () => {
  const budget = buildLatencyBudget({
    pipelineBaselineMs: 5000,
    playbackBufferSec: 5,
    e2eLatencyMs: 1000,
  });
  assert.equal(budget.residualMs, 0);
});

test("shares cover the whole measured delay", () => {
  const budget = buildLatencyBudget({
    pipelineBaselineMs: 1000,
    netRttMs: 40,
    playbackBufferSec: 2,
    e2eLatencyMs: 5000,
  });
  const shares = latencyBudgetShares(budget);
  if (!shares) {
    throw new Error("expected shares for a measured e2e");
  }
  const total = shares.reduce((sum, part) => sum + part.pct, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `shares summed to ${total}`);
});

test("frame drop percentages share a denominator convention", () => {
  // Same 10-in-100 loss must read identically on both sides of the chain.
  assert.equal(encodeFrameDropPct(90, 10), playbackFrameDropPct(90, 10));
  assert.equal(encodeFrameDropPct(90, 10), 10);
  // A genuine 24fps source is not dropping 20% of a 30fps expectation.
  assert.equal(encodeFrameDropPct(720, 0), 0);
});

test("frame delivery catches loss neither endpoint counter sees", () => {
  assert.equal(frameDeliveryPct(1000, 900), 90);
  // Player marginally ahead inside one sample interval is not >100%.
  assert.equal(frameDeliveryPct(900, 905), 100);
  assert.equal(frameDeliveryPct(0, 0), 0);
});
