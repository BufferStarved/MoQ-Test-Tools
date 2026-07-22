#!/usr/bin/env node
/**
 * Headless-Chrome QA harness: drives the real app UI end-to-end against a
 * live webcam comparison (SRT->MediaMTX, RTMP->Zixi, MoQ->OpenMoQ). Not part
 * of the production frontend bundle — lives in scripts/qa/ with its own tiny
 * package.json.
 *
 * This targets the *local dev stack* (./scripts/dev.sh) which still publishes
 * to the same shared cloud SRT/RTMP/MoQ ingest as prod, so it exercises the
 * real webcam-bridge pipeline (browser MediaRecorder -> WS -> ffmpeg bridge
 * -> UDP tee -> per-destination encode -> SRT/RTMP/MoQ) without touching the
 * live prod site directly.
 *
 * Uses Chrome's built-in fake *video* capture device (reliably produces real
 * MediaRecorder output — verified: 170KB+/3s of genuine webm chunks). Fake
 * *audio* capture is intentionally NOT used: on this host, requesting a fake
 * (or file-backed fake) audio device hangs getUserMedia forever instead of
 * resolving, and separately, MediaRecorder emits zero bytes for any stream
 * built from a non-getUserMedia audio source (AudioContext destination node,
 * or an HTMLVideoElement.captureStream() audio track) — both verified via
 * isolated repro scripts. So this harness simulates a "no working microphone"
 * environment: our getUserMedia patch synchronously rejects audio requests,
 * which exercises openWebcamStream()'s real production fallback-to-video-only
 * path (web/frontend/src/webcamCapture.ts) — including its timeout guard
 * against exactly this kind of hung audio permission request.
 *
 * Usage:
 *   node webcam-e2e.mjs [--base-url=http://127.0.0.1:5173] [--duration=45]
 */
import { chromium } from "playwright";

function argValue(flag, fallback) {
  const prefix = `--${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const baseUrl = argValue("base-url", "http://127.0.0.1:5173");
const watchSec = Number(argValue("duration", "45"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.grantPermissions(["camera", "microphone"]);
  const page = await context.newPage();
  // Chrome throttles video decode/capture to near-zero for an unfocused
  // page/tab in headless mode (verified via debug harness) — without this,
  // MediaRecorder starves for real frames.
  await page.bringToFront();

  // Simulate a "no working microphone" environment (see file header) so
  // openWebcamStream()'s real fallback-to-video-only path runs, using
  // Chrome's fake video device for the video track.
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio) {
        throw new DOMException("Simulated: no working microphone", "NotFoundError");
      }
      return original(constraints);
    };
  });
  lastPage = page;

  const consoleLogs = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLogs.push(`[pageerror] ${String(err)}`));
  const netLogs = [];
  page.on("requestfailed", (req) => {
    netLogs.push(`[requestfailed] ${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      netLogs.push(`[http${res.status()}] ${res.request().method()} ${res.url()}`);
    }
  });
  page.on("websocket", (ws) => {
    netLogs.push(`[ws-open] ${ws.url()}`);
    ws.on("close", () => netLogs.push(`[ws-close] ${ws.url()}`));
    ws.on("socketerror", (err) => netLogs.push(`[ws-error] ${ws.url()} :: ${err}`));
  });

  console.log(`Navigating to ${baseUrl} ...`);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

  // Wait for bootstrap: protocol/preset options loaded from the API.
  const startButton = page.getByRole("button", { name: /Start comparison/ });
  await startButton.waitFor({ state: "visible", timeout: 20_000 });
  console.log("App bootstrapped.");

  // Add a 3rd stream (defaults are SRT->MediaMTX, RTMP->Zixi) and point it at MoQ.
  const streamColumns = page.locator(".stream-column");
  let columnCount = await streamColumns.count();
  if (columnCount < 3) {
    await page.locator(".stream-add-chip").click();
    await sleep(200);
    columnCount = await streamColumns.count();
  }
  console.log(`Stream columns present: ${columnCount}`);

  const thirdColumn = streamColumns.nth(2);
  const protocolSelect = thirdColumn.locator("label:has-text('Protocol') select");
  await protocolSelect.selectOption("moq");
  await sleep(300);

  for (let i = 0; i < columnCount; i += 1) {
    const chip = await streamColumns.nth(i).locator(".stream-path-chips").textContent();
    console.log(`Stream ${i + 1} path: ${chip?.replace(/\s+/g, " ").trim()}`);
  }

  // Media source: Webcam (publisherHost stays "cloud" — browser MediaRecorder
  // -> WS bridge path, the one with the fixes we're validating).
  const sourceSelect = page.locator(".source-media-section label:has-text('Source') select");
  await sourceSelect.selectOption("webcam");
  await sleep(1000);

  const webcamHint = await page.locator(".webcam-preview-block, .source-media-section").last().textContent();
  console.log(`Webcam status: ${webcamHint?.replace(/\s+/g, " ").trim().slice(0, 200)}`);

  console.log("Starting comparison...");
  await startButton.click();

  const endAt = Date.now() + watchSec * 1000;
  let previewCheckDone = false;
  // Per-tile playhead tracker: the pass/fail signal that actually matches
  // what a human calls "smooth" — playhead advancing wall-second by
  // wall-second, no multi-second freezes.
  const playhead = { last: [0, 0, 0], frozen: [0, 0, 0], advancing: [0, 0, 0], samples: 0, maxFreeze: [0, 0, 0], curFreeze: [0, 0, 0] };
  while (Date.now() < endAt) {
    await sleep(5000);
    const statuses = await page.locator(".stream-column-status .pill").allTextContents();
    const times = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".stream-column")).map((col) => {
        const video = col.querySelector("video.player-video, video");
        return video ? video.currentTime : -1;
      });
    });
    playhead.samples += 1;
    const deltas = times.map((t, i) => {
      const d = t - playhead.last[i];
      playhead.last[i] = t;
      if (d > 2.5) playhead.advancing[i] += 1;
      else if (t > 0) {
        playhead.frozen[i] += 1;
        playhead.curFreeze[i] += 5;
        playhead.maxFreeze[i] = Math.max(playhead.maxFreeze[i], playhead.curFreeze[i]);
      }
      if (d > 2.5) playhead.curFreeze[i] = 0;
      return d.toFixed(1);
    });
    console.log(
      `[t+${Math.round((watchSec * 1000 - (endAt - Date.now())) / 1000)}s] job statuses: ${statuses.join(", ")} | playhead_d5s: ${deltas.join(", ")}`,
    );
    if (!previewCheckDone) {
      previewCheckDone = true;
      // The run collapses the recipe panel; the live source preview must
      // stay on screen and actually render frames (videoWidth > 0).
      const preview = page.locator(".webcam-preview-live video");
      const previewState = await preview
        .evaluate((el) => ({
          width: el.videoWidth,
          height: el.videoHeight,
          paused: el.paused,
          hasStream: Boolean(el.srcObject),
        }))
        .catch(() => null);
      console.log(
        previewState
          ? `[preview-during-run] visible=yes stream=${previewState.hasStream} playing=${!previewState.paused} size=${previewState.width}x${previewState.height}`
          : "[preview-during-run] visible=NO (regression: preview disappeared)",
      );
    }
  }

  console.log("\n=== Playhead smoothness verdict ===");
  for (let i = 0; i < 3; i += 1) {
    const active = playhead.advancing[i] + playhead.frozen[i];
    const pct = active > 0 ? Math.round((100 * playhead.advancing[i]) / active) : 0;
    console.log(
      `Stream ${i + 1}: advancing ${playhead.advancing[i]}/${active} intervals (${pct}%), longest freeze ~${playhead.maxFreeze[i]}s`,
    );
  }

  console.log("\n=== Per-stream diagnostics ===");
  for (let i = 0; i < columnCount; i += 1) {
    const column = streamColumns.nth(i);
    const chip = await column.locator(".stream-path-chips").textContent();
    const diagLines = await column.locator(".player-diagnostics li code").allTextContents();
    console.log(`\n--- Stream ${i + 1}: ${chip?.replace(/\s+/g, " ").trim()} ---`);
    for (const line of diagLines) {
      console.log(`  ${line}`);
    }
  }

  console.log("\n=== Browser console (last 60 lines) ===");
  for (const line of consoleLogs.slice(-60)) {
    console.log(line);
  }

  console.log("\n=== Network events ===");
  for (const line of netLogs) {
    console.log(line);
  }

  const errorBanner = await page.locator("p.error, .error-box, .toast").allTextContents();
  if (errorBanner.length) {
    console.log("\n=== Error banners ===");
    for (const line of errorBanner) console.log(line);
  }

  try {
    await page.getByRole("button", { name: /Stop webcam|Stop comparison/ }).click({ timeout: 5000 });
  } catch {
    // already stopped/finished
  }
  await sleep(1000);
  await browser.close();
}

let lastPage = null;
main().catch(async (err) => {
  console.error(err);
  if (lastPage) {
    try {
      await lastPage.screenshot({ path: "/tmp/qa_failure.png", fullPage: true });
      console.error("Saved failure screenshot to /tmp/qa_failure.png");
    } catch {
      // ignore
    }
  }
  process.exit(1);
});
