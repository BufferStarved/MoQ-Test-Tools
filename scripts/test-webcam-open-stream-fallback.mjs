#!/usr/bin/env node
/**
 * Regression check for web/frontend/src/webcamCapture.ts's openWebcamStream()
 * audio+video -> video-only fallback.
 *
 * Root cause this guards against: a stuck mic permission prompt, a
 * misbehaving audio driver, or (confirmed live via the scripts/qa/ QA
 * harness) certain sandboxed browser environments can leave
 * getUserMedia({audio: true, ...}) pending forever instead of rejecting.
 * The original code only had a try/catch around it, which never runs
 * without a rejection — so a hang there hung the whole comparison start
 * indefinitely instead of falling back to video-only. openWebcamStream()
 * now races the audio+video attempt against a timeout so a broken audio
 * device degrades gracefully instead of hanging forever.
 *
 * No test framework is wired up for web/frontend yet, so this transpiles the
 * real module with esbuild (already a vite dependency) and runs plain
 * assertions against it with fake getUserMedia globals — cheap, zero new
 * dependencies. Mirrors scripts/test-webcam-capture-ordering.mjs.
 *
 * Run: node scripts/test-webcam-open-stream-fallback.mjs
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

const tmpDir = mkdtempSync(path.join(tmpdir(), "moq-webcam-open-stream-"));
const outFile = path.join(tmpDir, "webcamCapture.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node ships a built-in read-only global `navigator`; a plain assignment
// throws ("has only a getter"). Redefine the property instead.
function setGlobalNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

try {
  execFileSync(
    esbuild,
    ["src/webcamCapture.ts", "--bundle", "--format=cjs", `--outfile=${outFile}`, "--platform=node"],
    { cwd: frontendDir, stdio: "inherit" },
  );

  globalThis.window = globalThis;
  const { openWebcamStream } = await import(outFile);

  // --- Case 1: audio+video getUserMedia hangs forever (never resolves or
  // rejects) — must still resolve with a video-only stream, and quickly
  // (well under the module's internal timeout), not wait for real time to
  // pass in this test.
  {
    const calls = [];
    setGlobalNavigator({
      mediaDevices: {
        getUserMedia: (constraints) => {
          calls.push(constraints);
          if (constraints.audio) {
            return new Promise(() => {}); // never settles
          }
          return Promise.resolve({ __kind: "video-only-fallback" });
        },
      },
    });

    // Don't wait for the real ~6s timeout — just confirm it eventually
    // resolves to the video-only fallback rather than hanging forever, by
    // racing against a much shorter local deadline than the module's own.
    const result = await Promise.race([
      openWebcamStream(),
      sleep(9000).then(() => ({ __kind: "test-deadline-exceeded" })),
    ]);
    assert.equal(
      result.__kind,
      "video-only-fallback",
      "a hung audio+video getUserMedia must fall back to a video-only stream instead of hanging forever",
    );
    assert.equal(calls.length, 2, "must attempt audio+video first, then fall back to video-only");
    assert.equal(calls[0].audio, true);
    assert.equal(calls[1].audio, false);
  }

  // --- Case 2: audio+video getUserMedia resolves normally and quickly —
  // must use that stream directly, no fallback call.
  {
    const calls = [];
    setGlobalNavigator({
      mediaDevices: {
        getUserMedia: (constraints) => {
          calls.push(constraints);
          return Promise.resolve({ __kind: "audio-video-ok" });
        },
      },
    });

    const result = await openWebcamStream();
    assert.equal(result.__kind, "audio-video-ok");
    assert.equal(calls.length, 1, "must not fall back when audio+video succeeds");
  }

  // --- Case 3: audio+video getUserMedia rejects immediately (e.g. no mic
  // hardware) — must still fall back to video-only, same as before this fix.
  {
    const calls = [];
    setGlobalNavigator({
      mediaDevices: {
        getUserMedia: (constraints) => {
          calls.push(constraints);
          if (constraints.audio) {
            return Promise.reject(new Error("NotFoundError: no microphone"));
          }
          return Promise.resolve({ __kind: "video-only-fallback" });
        },
      },
    });

    const result = await openWebcamStream();
    assert.equal(result.__kind, "video-only-fallback");
    assert.equal(calls.length, 2);
  }

  console.log("PASS: openWebcamStream audio+video -> video-only fallback regression checks");
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
