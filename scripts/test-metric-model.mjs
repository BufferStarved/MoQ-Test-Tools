#!/usr/bin/env node
/**
 * Regression check for web/frontend/src/metricModel.ts e2e latency math.
 *
 * MoQ MSE timelines re-zero at join (`video.currentTime ≈ 0`). wall−vt on that
 * clock freezes at join delay and is **not** glass-to-glass — it disagreed with
 * the burnt-in ENC clock while SRT/RTMP looked right. estimateMoqE2eLatencyMs
 * must prefer CaptureTimestamp when present, otherwise buffer lead — never
 * treat join-delay wall−vt as G2G.
 *
 * Run: node scripts/test-metric-model.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const frontendDir = path.join(repoRoot, "web", "frontend");
const esbuild = path.join(frontendDir, "node_modules", ".bin", "esbuild");

const tmpDir = mkdtempSync(path.join(tmpdir(), "moq-metric-model-"));
const outFile = path.join(tmpDir, "metricModel.cjs");

try {
  execFileSync(
    esbuild,
    ["src/metricModel.ts", "--bundle", "--format=cjs", `--outfile=${outFile}`, "--platform=node"],
    { cwd: frontendDir, stdio: "inherit" },
  );

  const { estimateE2eLatencyMs, estimateMoqE2eLatencyMs } = await import(outFile);

  // --- estimateE2eLatencyMs basics ---
  assert.equal(estimateE2eLatencyMs(null, 5), null, "null encode start -> null");
  assert.equal(estimateE2eLatencyMs(Date.now() / 1000, 0), null, "zero video time -> null");

  {
    const encodeStart = (Date.now() - 4200) / 1000;
    const latency = estimateE2eLatencyMs(encodeStart, 4.0);
    assert.ok(latency !== null && latency >= 0 && latency < 1000, `RTMP-like low latency, got ${latency}`);
  }

  // --- MoQ must not treat join-delay wall−vt as glass-to-glass ---
  {
    const encodeStart = (Date.now() - 10_000) / 1000;
    const videoTimeSec = 0.5; // MSE remapped the live edge to ~0 on join.
    const bufferSec = 2.0;
    const targetLatencyMs = 800;

    const wallVt = estimateE2eLatencyMs(encodeStart, videoTimeSec);
    assert.ok(wallVt !== null && wallVt > 9000 && wallVt < 10_000, `expected wallVt ~9.5s, got ${wallVt}`);

    const moqE2e = estimateMoqE2eLatencyMs({
      encodeStartedAtEpoch: encodeStart,
      videoTimeSec,
      bufferSec,
      playerLatencyMs: 0,
      targetLatencyMs,
    });
    assert.equal(
      moqE2e,
      Math.round(bufferSec * 1000 + 250),
      `MoQ e2e must use buffer lead, not join-delay wall−vt. Got ${moqE2e}`,
    );
    assert.notEqual(moqE2e, wallVt, "MoQ e2e must not equal join-delay wall−vt");
  }

  // --- Player-reported CaptureTimestamp latency still wins when present. ---
  {
    const moqE2e = estimateMoqE2eLatencyMs({
      encodeStartedAtEpoch: (Date.now() - 10_000) / 1000,
      videoTimeSec: 0.5,
      bufferSec: 2.0,
      playerLatencyMs: 1234,
      targetLatencyMs: 800,
    });
    assert.equal(moqE2e, 1234, "player-reported latency must take priority over buffer");
  }

  // --- No buffer yet → null (waiting for first media). ---
  {
    const moqE2e = estimateMoqE2eLatencyMs({
      encodeStartedAtEpoch: null,
      videoTimeSec: 0.5,
      bufferSec: 0,
      targetLatencyMs: 800,
    });
    assert.equal(moqE2e, null, "no buffer and no CaptureTimestamp -> null");
  }

  console.log("PASS: metricModel e2e latency regression checks");
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
