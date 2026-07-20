#!/usr/bin/env node
/**
 * Regression check for web/frontend/src/metricModel.ts e2e latency math.
 *
 * Root cause this guards against: estimateMoqE2eLatencyMs used to replace any
 * "large" wall-vt estimate with a small `bufferSec + 250ms` guess, on the
 * theory that a high number must be a stuck-MSE-timeline artifact. In
 * practice that threshold (bufferMs + target + 500ms, often ~3s) is *lower*
 * than a normal MoQ join latency, so real ~10s glass-to-glass latency was
 * silently reported as ~2-4s — making the slowest leg look the fastest in
 * cross-protocol comparisons. See docs/METRICS.md and the 2026-07-19 prod
 * incident (SRT playhead + e2e latency bug report).
 *
 * No test framework is wired up for web/frontend yet, so this transpiles the
 * real module with esbuild (already a vite dependency) and runs plain
 * assertions against it — cheap, zero new dependencies, catches regressions
 * of this specific formula.
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

  // --- The actual regression: MoQ must not collapse high latency to a low
  // buffer-based guess. ~10s join latency, small live buffer (2s). ---
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
    assert.ok(
      moqE2e !== null && moqE2e > 9000 && moqE2e < 10_000,
      `MoQ e2e must report the real ~9.5s join latency, not a low buffer-based guess. Got ${moqE2e}`,
    );

    // Guard the regression explicitly: the buggy fallback threshold used to
    // fire for exactly this input and would have reported ~2.25s instead.
    const buggyThreshold = bufferSec * 1000 + Math.max(100, targetLatencyMs) + 500;
    assert.ok(
      wallVt > buggyThreshold,
      "sanity: this scenario must exceed the old (buggy) override threshold",
    );
    assert.notEqual(
      moqE2e,
      Math.round(bufferSec * 1000 + 250),
      "MoQ e2e must not equal the old low-latency fallback value",
    );
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
    assert.equal(moqE2e, 1234, "player-reported latency must take priority over wall-vt");
  }

  // --- Fallback only fires when wall-vt truly can't be computed. ---
  {
    const moqE2e = estimateMoqE2eLatencyMs({
      encodeStartedAtEpoch: null,
      videoTimeSec: 0.5,
      bufferSec: 2.0,
      targetLatencyMs: 800,
    });
    assert.equal(moqE2e, 2250, "fallback used only when wall-vt is unavailable");
  }

  console.log("PASS: metricModel e2e latency regression checks");
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
