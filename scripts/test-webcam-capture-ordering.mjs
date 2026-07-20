#!/usr/bin/env node
/**
 * Regression check for web/frontend/src/webcamCapture.ts chunk ordering.
 *
 * Root cause this guards against: MediaRecorder.ondataavailable fires once
 * per ~100ms slice of ONE continuous WebM recording (not independent
 * files). The old handler called `blob.arrayBuffer()` and sent the result
 * independently per chunk without awaiting the previous chunk's send.
 * `Blob.arrayBuffer()` resolution order across separate blobs is not
 * guaranteed by spec, so under load/GC pressure a later chunk could reach
 * `ws.send()` before an earlier one, corrupting the WebM byte stream the
 * server ffmpeg bridge depends on for valid cluster framing. ffmpeg's webm
 * demuxer then bailed ("truncated cluster"), the bridge restarted with a
 * fresh PTS clock mid-stream, and downstream SRT/RTMP/MoQ encoders reading
 * the same live UDP feed saw a PTS discontinuity — surfacing as HLS.js
 * bufferAppendError crashes on RTMP/Zixi and segment churn on SRT (2026-07-19
 * live webcam QA incident).
 *
 * No test framework is wired up for web/frontend yet, so this transpiles the
 * real module with esbuild (already a vite dependency) and runs plain
 * assertions against it with fake WebSocket/MediaRecorder globals — cheap,
 * zero new dependencies.
 *
 * Run: node scripts/test-webcam-capture-ordering.mjs
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

const tmpDir = mkdtempSync(path.join(tmpdir(), "moq-webcam-capture-"));
const outFile = path.join(tmpDir, "webcamCapture.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A blob whose arrayBuffer() resolves after `resolveDelayMs` — used to
// simulate MediaRecorder blobs whose async byte-reads don't resolve in the
// same order they were produced.
function fakeBlob(tag, resolveDelayMs) {
  return {
    size: 1,
    arrayBuffer: () => new Promise((resolve) => setTimeout(() => resolve(tag), resolveDelayMs)),
  };
}

try {
  execFileSync(
    esbuild,
    ["src/webcamCapture.ts", "--bundle", "--format=cjs", `--outfile=${outFile}`, "--platform=node"],
    { cwd: frontendDir, stdio: "inherit" },
  );

  let lastWebSocket = null;
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.binaryType = "blob";
      this.sent = [];
      this.onopen = null;
      this.onerror = null;
      this.onmessage = null;
      lastWebSocket = this;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(data) {
      this.sent.push(data);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }

  let lastRecorder = null;
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor(stream, opts) {
      this.stream = stream;
      this.opts = opts;
      this.state = "inactive";
      this.ondataavailable = null;
      this.onerror = null;
      lastRecorder = this;
    }

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
    }
  }

  globalThis.window = globalThis;
  globalThis.window.location = { protocol: "http:", host: "localhost:8000" };
  globalThis.WebSocket = FakeWebSocket;
  globalThis.MediaRecorder = FakeMediaRecorder;

  const { startLiveWebcamBroadcast } = await import(outFile);

  const fakeStream = { getTracks: () => [] };
  const broadcast = startLiveWebcamBroadcast({
    stream: fakeStream,
    wsPath: "/api/live/sessions/test/ws",
  });
  assert.ok(broadcast, "startLiveWebcamBroadcast must return a handle");

  await sleep(10); // let the fake WebSocket's onopen microtask + recorder.start() fire.
  assert.ok(lastRecorder, "MediaRecorder must have been constructed");
  assert.equal(lastRecorder.state, "recording", "recorder must be started once the WS opens");
  assert.ok(lastWebSocket, "WebSocket must have been constructed");
  assert.equal(lastWebSocket.readyState, FakeWebSocket.OPEN, "WS must be open before we dispatch chunks");

  // --- The actual regression: dispatch chunk "A" (slow arrayBuffer, 40ms),
  // then "B" (fast, 5ms), then "C" (medium, 15ms). Without the send-chain
  // fix, B and C's sends would race ahead of A's because their
  // `arrayBuffer()` promises resolve first. Byte order must match dispatch
  // order regardless of each chunk's own resolution latency.
  lastRecorder.ondataavailable({ data: fakeBlob("A", 40) });
  lastRecorder.ondataavailable({ data: fakeBlob("B", 5) });
  lastRecorder.ondataavailable({ data: fakeBlob("C", 15) });

  await sleep(120);

  assert.deepEqual(
    lastWebSocket.sent,
    ["A", "B", "C"],
    `chunks must be sent in dispatch order regardless of arrayBuffer() resolution timing, got ${JSON.stringify(lastWebSocket.sent)}`,
  );

  // Zero-size chunks (MediaRecorder can emit these) must not jam the chain.
  lastWebSocket.sent.length = 0;
  lastRecorder.ondataavailable({ data: { size: 0, arrayBuffer: () => Promise.reject(new Error("should not be called")) } });
  lastRecorder.ondataavailable({ data: fakeBlob("D", 5) });
  await sleep(30);
  assert.deepEqual(lastWebSocket.sent, ["D"], "zero-size chunks must be skipped without blocking later chunks");

  // stop() must clear the internal 25s "ready" timeout — otherwise a user
  // pressing Stop before the bridge ever reported ready would still see a
  // stray "Timed out waiting for live webcam bridge" rejection fire later.
  broadcast.stop();
  await sleep(5);

  console.log("PASS: webcamCapture chunk ordering regression checks");
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
