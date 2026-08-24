import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildComparisonVerdict,
  captureClassHintMs,
  compareLiveMetrics,
  e2eScopeHudLabel,
  e2eScopeShortLabel,
} from "./comparisonVerdict.ts";
import type { ResultSummary } from "./types.ts";

function stream(partial: {
  protocol: string;
  e2e: number;
  encode?: number;
  ttff?: number;
  engine?: string;
  label?: string;
}): ResultSummary {
  return {
    filename: `${partial.protocol}.csv`,
    samples: 40,
    protocol: partial.protocol,
    averages: {
      e2e_latency_ms: partial.e2e,
      latency_encode_ms: partial.encode,
      playback_ttff_ms: partial.ttff ?? 9000,
      playback_stall_count: 0,
    },
    summary_extra: {
      stream_label: partial.label,
      playback_engine: partial.engine,
    },
  };
}

describe("e2e scope labels", () => {
  it("names ingest vs capture and does not call TTFF glass", () => {
    assert.equal(e2eScopeShortLabel("ingest_to_glass"), "ingest-to-glass");
    assert.equal(e2eScopeShortLabel("capture_to_glass"), "capture-to-glass");
    assert.equal(e2eScopeHudLabel("ingest_to_glass"), "Latency · ingest path");
    assert.equal(e2eScopeHudLabel("capture_to_glass"), "Latency · glass");
    assert.equal(e2eScopeHudLabel("capture_to_ingest"), "Latency · ingest path");
  });
});

describe("captureClassHintMs", () => {
  it("adds encode only onto ingest-to-glass (comparison 26 WebRTC)", () => {
    assert.equal(captureClassHintMs(206, 358, "ingest_to_glass"), 564);
    assert.equal(captureClassHintMs(5747, 1848, "capture_to_glass"), undefined);
  });
});

describe("compareLiveMetrics", () => {
  it("does not crown WebRTC over MoQ across mixed scopes", () => {
    const ranks = compareLiveMetrics([
      { e2e_latency_ms: 6348, protocol: "rtmp" },
      { e2e_latency_ms: 2913, protocol: "srt" },
      { e2e_latency_ms: 206, protocol: "webrtc", latency_e2e_scope: "ingest_to_glass" },
      { e2e_latency_ms: 5747, protocol: "moq" },
    ]);
    assert.equal(ranks.latency.bestIndex, null);
    assert.deepEqual(ranks.latency.deltaVsBest, [null, null, null, null]);
  });

  it("still ranks latency when every leg shares a scope", () => {
    const ranks = compareLiveMetrics([
      { e2e_latency_ms: 2913, protocol: "srt" },
      { e2e_latency_ms: 5747, protocol: "moq" },
    ]);
    assert.equal(ranks.latency.bestIndex, 0);
    assert.equal(ranks.latency.deltaVsBest[1], 2834);
  });
});

describe("buildComparisonVerdict", () => {
  it("does not declare WebRTC wins glass by 6s without scope (comparison 26)", () => {
    const verdict = buildComparisonVerdict([
      stream({ protocol: "rtmp", e2e: 6348, encode: 1133, label: "RTMP" }),
      stream({ protocol: "srt", e2e: 2913, encode: 1333, label: "SRT" }),
      stream({
        protocol: "webrtc",
        e2e: 206,
        encode: 358,
        engine: "whep",
        label: "WebRTC",
      }),
      stream({ protocol: "moq", e2e: 5747, encode: 1848, label: "MoQ" }),
    ]);
    assert.ok(verdict);
    assert.equal(/glass delay/i.test(verdict.headline), false);
    assert.match(verdict.headline, /ingest-to-glass/);
    assert.match(verdict.headline, /capture-to-glass/);
    assert.equal(
      verdict.highlights.some((item) => item.label === "Lowest glass delay"),
      false,
    );
    const ingest = verdict.highlights.find((item) => item.label === "Lowest ingest-to-glass");
    const capture = verdict.highlights.find((item) => item.label === "Lowest capture-to-glass");
    assert.equal(ingest?.winner, "WebRTC");
    assert.equal(capture?.winner, "SRT");
    const hint = verdict.highlights.find((item) => item.label === "WebRTC as capture-class");
    assert.match(hint?.value ?? "", /564/);
  });
});
