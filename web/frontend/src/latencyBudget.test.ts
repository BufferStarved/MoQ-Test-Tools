import assert from "node:assert/strict";
import { test } from "node:test";

import {
  E2E_SCOPE_CAPTURE_TO_GLASS,
  E2E_SCOPE_CAPTURE_TO_INGEST,
  E2E_SCOPE_INGEST_TO_GLASS,
  applyLatencyBudgetToSample,
  BROKER_GOP_MS,
  buildLatencyBudget,
  e2eScopeFor,
  encodeFrameDropPct,
  encodeLatencyMs,
  frameDeliveryPct,
  latencyBudgetShares,
  LL_HLS_PART_MS,
  networkLatencyMs,
  playbackFrameDropPct,
  playerBufferLatencyMs,
  resolveSegmentationMs,
} from "./latencyBudget.ts";
import { moqGopFramesForLatency, moqGroupDurationMs } from "./encodeProfiles.ts";

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

test("a component past the sanity ceiling is dropped, not clamped to it", () => {
  // Clamping turned a 70s parse artifact into a confident 60s stage that
  // stacked and summed exactly like a real measurement.
  assert.equal(playerBufferLatencyMs(4), 4000);
  assert.equal(playerBufferLatencyMs(undefined), 0);
  assert.equal(playerBufferLatencyMs(70), 0);
  assert.equal(playerBufferLatencyMs(99_999), 0);
});

test("measured glass delay keeps a wider ceiling than a single stage", () => {
  // A badly broken leg really does sit at 37s (job c49d2ef4) and the total
  // has to survive to be charted; only a stage is capped at 60s.
  const budget = buildLatencyBudget({ e2eLatencyMs: 90_000, packagerTransitMs: 0 });
  assert.equal(budget.e2eMs, 90_000);
});

test("residual exposes glass delay the components cannot explain", () => {
  // Zixi Fast HLS carries no PDT, so the packager stage has no instrument.
  // That has to surface as unattributed *and named*, not as a measured zero.
  const budget = buildLatencyBudget({
    pipelineBaselineMs: 1500,
    netRttMs: 60,
    playbackBufferSec: 4,
    e2eLatencyMs: 12_000,
  });
  assert.equal(budget.accountedMs, 1500 + 30 + 4000);
  assert.equal(budget.residualMs, 12_000 - budget.accountedMs);
  assert.equal(budget.overcountMs, 0);
  assert.deepEqual(budget.unmeasured, [
    "latency_segmentation_ms",
    "latency_publish_ms",
    "latency_packager_ms",
  ]);
});

test("a measured zero is not the same as an unmeasured stage", () => {
  const measured = buildLatencyBudget({ packagerTransitMs: 0, e2eLatencyMs: 500 });
  assert.ok(!measured.unmeasured.includes("latency_packager_ms"));
  const unmeasured = buildLatencyBudget({ e2eLatencyMs: 500 });
  assert.ok(unmeasured.unmeasured.includes("latency_packager_ms"));
});

test("no e2e measurement means nothing to attribute", () => {
  const budget = buildLatencyBudget({ pipelineBaselineMs: 1500 });
  assert.equal(budget.accountedMs, 1500);
  assert.equal(budget.residualMs, 0);
  assert.equal(budget.overcountMs, 0);
  assert.equal(latencyBudgetShares(budget), null);
});

test("over-attribution is reported, not hidden behind a clamped residual", () => {
  const budget = buildLatencyBudget({
    pipelineBaselineMs: 5000,
    playbackBufferSec: 5,
    e2eLatencyMs: 1000,
  });
  assert.equal(budget.residualMs, 0);
  assert.equal(budget.overcountMs, 9000);
});

test("WHEP's receiver-side e2e is not charged for the sender pipeline", () => {
  // Linode WebRTC 2026-08-22: 1419ms of components against a 35ms measured
  // e2e, reported as a perfectly reconciled 0 residual. The encode stage is a
  // sender-side offset that WHEP's jitter-buffer estimate cannot see.
  const input = {
    pipelineBaselineMs: 1400,
    netRttMs: 37,
    playbackBufferSec: 0.03,
    e2eLatencyMs: 35,
  };
  const wrong = buildLatencyBudget({ ...input, e2eScope: E2E_SCOPE_CAPTURE_TO_GLASS });
  assert.ok(wrong.overcountMs > 1300, "capture-scope sum over-attributes by the whole baseline");

  const budget = buildLatencyBudget({ ...input, e2eScope: E2E_SCOPE_INGEST_TO_GLASS });
  // Still reported — the operator needs to know the sender pipeline exists.
  assert.equal(budget.encodeMs, 1400);
  // But not summed against an estimate that never spanned it.
  assert.equal(budget.accountedMs, 18.5 + 30);
  assert.ok(budget.overcountMs < 15, `overcount ${budget.overcountMs}`);
});

test("scope follows the player that computes e2e, not the publish protocol", () => {
  assert.equal(e2eScopeFor("webrtc", "whep"), E2E_SCOPE_INGEST_TO_GLASS);
  assert.equal(e2eScopeFor("webrtc"), E2E_SCOPE_INGEST_TO_GLASS);
  // A WHIP publish watched through the LL-HLS remux really is capture-to-glass.
  assert.equal(e2eScopeFor("webrtc", "hls"), E2E_SCOPE_CAPTURE_TO_GLASS);
  assert.equal(e2eScopeFor("moq", "moq"), E2E_SCOPE_CAPTURE_TO_GLASS);
  assert.equal(e2eScopeFor("moq", "moq", "upload"), E2E_SCOPE_CAPTURE_TO_INGEST);
  assert.equal(e2eScopeFor("srt", "monitor"), E2E_SCOPE_CAPTURE_TO_INGEST);
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

test("shares omit out-of-scope stages and surface over-attribution", () => {
  const budget = buildLatencyBudget({
    pipelineBaselineMs: 1400,
    netRttMs: 37,
    playbackBufferSec: 0.03,
    e2eLatencyMs: 35,
    e2eScope: E2E_SCOPE_INGEST_TO_GLASS,
  });
  const shares = latencyBudgetShares(budget);
  if (!shares) {
    throw new Error("expected shares for a measured e2e");
  }
  // A sender-side bar on a receiver-side total would be taller than the whole.
  assert.ok(!shares.some((part) => part.key === "latency_encode_ms"));
  assert.ok(shares.some((part) => part.key === "overcount"));
});

test("frame drop percentages share a denominator convention", () => {
  // Same 10-in-100 loss must read identically on both sides of the chain.
  assert.equal(encodeFrameDropPct(90, 10), playbackFrameDropPct(90, 10));
  assert.equal(encodeFrameDropPct(90, 10), 10);
  // A genuine 24fps source is not dropping 20% of a 30fps expectation.
  assert.equal(encodeFrameDropPct(720, 0), 0);
});

test("frame delivery needs a window both counters share", () => {
  // Raw cumulative totals measure the attach offset, not delivery.
  assert.equal(frameDeliveryPct(1000, 900), null);
  // Encoder at 400 and player at 30 when the player attached; 300 encoded and
  // 300 painted since means nothing was lost, however far apart the totals are.
  assert.equal(frameDeliveryPct(700, 330, 400, 30), 100);
  assert.equal(frameDeliveryPct(700, 180, 400, 30), 50);
});

test("frame delivery goes to zero when a live player stops painting", () => {
  // Linode Zixi RTMP: rendered froze at 84 while encoded climbed to 835. The
  // old ratio decayed 48% → 10% as if loss were ramping; the truth is that
  // nothing has been painted since, which is 0% over the shared window.
  assert.equal(frameDeliveryPct(835, 84, 300, 84), 0);
});

test("frame delivery does not clamp a player reading ahead to a perfect score", () => {
  // >100% is clock skew or a mis-placed attach point. Clamping hid it.
  const pct = frameDeliveryPct(500, 260, 400, 30);
  assert.ok(pct !== null && pct > 100, `expected >100%, got ${pct}`);
});

test("live overlay recomputes player buffer and residual after e2e arrives", () => {
  // comparison 2026-08-23: RTMP e2e 9970ms, buffer 1.67s, residual stayed 0
  // because the encoder loop wrote the budget before the browser reported.
  const sample = applyLatencyBudgetToSample({
    protocol: "rtmp",
    latency_encode_ms: 1166.6,
    latency_network_ms: 17.9,
    latency_packager_ms: 0,
    latency_publish_ms: 0,
    latency_unmeasured: "publish,packager",
    net_rtt_ms: 35.8,
    playback_buffer_sec: 1.67,
    e2e_latency_ms: 9970,
    latency_e2e_scope: "capture_to_glass",
  });
  assert.equal(sample.latency_player_buffer_ms, 1670);
  assert.ok(sample.latency_residual_ms > 7000, `residual ${sample.latency_residual_ms}`);
  assert.match(sample.latency_unmeasured, /publish/);
  assert.match(sample.latency_unmeasured, /packager/);
});

test("upload scope ranks capture-to-ingest accounted, not monitor glass", () => {
  const budget = buildLatencyBudget({
    pipelineBaselineMs: 400,
    publishTransitMs: 80,
    netRttMs: 40,
    packagerTransitMs: 25,
    playbackBufferSec: 2,
    e2eLatencyMs: 0,
    e2eScope: E2E_SCOPE_CAPTURE_TO_INGEST,
  });
  assert.ok(budget.playerBufferMs > 0);
  assert.ok(!budget.accountedMs.toString().includes("NaN"));
  assert.equal(
    budget.accountedMs,
    budget.encodeMs + budget.segmentationMs + budget.publishMs + budget.networkMs + budget.packagerMs,
  );

  const sample = applyLatencyBudgetToSample({
    protocol: "moq",
    test_scope: "upload",
    latency_encode_ms: 400,
    latency_publish_ms: 80,
    latency_network_ms: 20,
    latency_packager_ms: 25,
    playback_buffer_sec: 2,
    e2e_latency_ms: 0,
  });
  assert.equal(sample.latency_e2e_scope, E2E_SCOPE_CAPTURE_TO_INGEST);
  assert.ok((sample.e2e_latency_ms as number) > 0);
  assert.ok((sample.e2e_latency_ms as number) < 2000, "must not copy 2s monitor buffer as glass");
});

test("MoQ CMAF group is segmentation, not ingest, and splits GOP out of encode", () => {
  const budget = buildLatencyBudget({
    protocol: "moq",
    pipelineBaselineMs: 1800,
    segmentationMs: 500,
    splitEncodeGop: true,
    e2eLatencyMs: 4000,
  });
  assert.equal(budget.segmentationMs, 500);
  assert.equal(budget.encodeMs, 1300);
  assert.ok(!budget.unmeasured.includes("latency_segmentation_ms"));
  assert.ok(!budget.notApplicable.includes("latency_segmentation_ms"));
});

test("unknown MoQ GOP is unmeasured, not 0", () => {
  const budget = buildLatencyBudget({ protocol: "moq", e2eLatencyMs: 4000 });
  assert.equal(budget.segmentationMs, 0);
  assert.ok(budget.unmeasured.includes("latency_segmentation_ms"));
});

test("WebRTC has no CMAF group hop", () => {
  const budget = buildLatencyBudget({
    protocol: "webrtc",
    e2eScope: E2E_SCOPE_INGEST_TO_GLASS,
    e2eLatencyMs: 35,
    netRttMs: 37,
    playbackBufferSec: 0.03,
  });
  assert.ok(budget.notApplicable.includes("latency_segmentation_ms"));
  assert.ok(!budget.unmeasured.includes("latency_segmentation_ms"));
  const resolved = resolveSegmentationMs({ protocol: "webrtc" });
  assert.equal(resolved.notApplicable, true);
});

test("LL-HLS parts are 200ms, not a 1s CMAF group", () => {
  const resolved = resolveSegmentationMs({ protocol: "hls", playbackEngine: "ll-hls" });
  assert.equal(resolved.ms, LL_HLS_PART_MS);
  assert.notEqual(resolved.ms, BROKER_GOP_MS);
  const budget = buildLatencyBudget({
    protocol: "hls",
    playbackEngine: "ll-hls",
    e2eLatencyMs: 800,
  });
  assert.equal(budget.segmentationMs, 200);
});

test("solo MoQ group is 0.25s; brokered copy stays 1s", () => {
  assert.equal(moqGopFramesForLatency(400), 8);
  assert.equal(moqGroupDurationMs(400), 266.7);
  assert.equal(moqGroupDurationMs(400, { brokered: true }), 1000);
});

test("metric definitions name CMAF group and refuse to call it ingest", async () => {
  const { METRIC_DEFINITIONS } = await import("./metricDefinitions.ts");
  const seg = METRIC_DEFINITIONS.latency_segmentation_ms;
  assert.equal(seg.label, "Latency · CMAF group (segmentation)");
  assert.match(seg.description, /NextGroupStart/);
  assert.match(seg.description, /not ingest RTT/);
  assert.match(METRIC_DEFINITIONS.latency_encode_ms.description, /not here/);
  assert.match(METRIC_DEFINITIONS.e2e_latency_ms.description, /never playa latencyMs/);
});
