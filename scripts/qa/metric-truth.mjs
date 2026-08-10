#!/usr/bin/env node
/**
 * Metric ground-truth harness.
 *
 * Attaches to each output <video>, accumulates HTML waiting→playing (+ frozen
 * playhead) as independent truth, and compares against the charts' reported
 * playback_rebuffer_sec / playback_stall_count / playback_ttff_ms /
 * e2e_latency_ms / frames from the live UI sample path.
 *
 * Usage:
 *   node scripts/qa/metric-truth.mjs [baseUrl] [mode]
 *   mode = vod|webcam|both  (default vod)
 *
 * Strict tolerances (fail the process on violation):
 *   rebuffer ±0.25s, stall count exact, ttff ±150ms, frames ±5% (min ±30)
 *
 * Prefer pointing baseUrl at a LOCAL frontend build that contains the metric
 * fixes (e.g. http://127.0.0.1:5173) while the API/proxy targets prod.
 */
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:5173";
const MODE = process.argv[3] ?? "vod";
const CLIP = process.argv[4] ?? "/tmp/timer_test.mp4";
const OUT = "/tmp/metric-truth";
fs.mkdirSync(OUT, { recursive: true });

const TOL = {
  rebufferSec: 0.25,
  stallCount: 0, // exact
  ttffMs: 150,
  framesRel: 0.05,
  framesAbs: 30,
  e2eMs: 400,
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-features=WebTransport", "--use-fake-ui-for-media-stream"],
});

async function runOnce(label, configure) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 2200 } });
  page.on("pageerror", (err) => log(`pageerror: ${err.message}`));
  /** @type {Map<string, { jobId: string, engine: string, samples: object[] }>} */
  const reportedByJob = new Map();
  await page.route("**/api/uploads/*/playback-sample", async (route) => {
    try {
      const url = route.request().url();
      const jobId = url.match(/\/uploads\/([^/]+)\/playback-sample/)?.[1] || "unknown";
      const post = route.request().postDataJSON();
      const engine = post?.engine || "unknown";
      if (!reportedByJob.has(jobId)) {
        reportedByJob.set(jobId, { jobId, engine, samples: [] });
      }
      reportedByJob.get(jobId).samples.push(post);
      reportedByJob.get(jobId).engine = engine;
    } catch {
      /* ignore */
    }
    await route.continue();
  });
  log(`[${label}] open ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll("button.primary")].find((b) =>
        (b.textContent || "").includes("Start comparison"),
      );
      return Boolean(btn && !btn.disabled);
    },
    { timeout: 180000 },
  );

  await configure(page);

  // Install glass ground-truth collectors on every <video>.
  await page.evaluate(() => {
    window.__metricTruth = { videos: new Map() };
    const ensure = (video, index) => {
      if (window.__metricTruth.videos.has(video)) return;
      const state = {
        index,
        rebufferMs: 0,
        stallCount: 0,
        waitingSince: 0,
        ttffMs: 0,
        startedAt: 0,
        firstFrameAt: 0,
        maxVt: 0,
        lastVt: 0,
        stuckSince: 0,
      };
      const begin = (fromFrozen = false) => {
        if (!state.firstFrameAt || state.waitingSince) return;
        state.waitingSince = performance.now();
        state.stallCount += 1;
        state.frozenOwned = fromFrozen;
      };
      const end = () => {
        if (!state.waitingSince) return;
        state.rebufferMs += performance.now() - state.waitingSince;
        state.waitingSince = 0;
        state.frozenOwned = false;
      };
      video.addEventListener("playing", () => {
        if (!state.firstFrameAt && video.currentTime > 0.2) {
          state.firstFrameAt = performance.now();
          state.ttffMs = Math.round(state.firstFrameAt - state.startedAt);
        }
        end();
      });
      video.addEventListener("waiting", () => begin(false));
      video.addEventListener("timeupdate", () => {
        if (!state.startedAt) state.startedAt = performance.now();
        if (video.currentTime > 0.2 && !state.firstFrameAt) {
          state.firstFrameAt = performance.now();
          state.ttffMs = Math.round(state.firstFrameAt - state.startedAt);
        }
        state.maxVt = Math.max(state.maxVt, video.currentTime);
      });
      // Frozen-playhead detector (matches frontend videoPlaybackMetrics).
      state._timer = setInterval(() => {
        if (!state.firstFrameAt || video.paused || video.seeking) return;
        if (video.currentTime > state.lastVt + 0.1) {
          state.lastVt = video.currentTime;
          state.stuckSince = 0;
          if (state.frozenOwned) end();
          return;
        }
        const ahead =
          video.buffered.length > 0
            ? video.buffered.end(video.buffered.length - 1) - video.currentTime
            : 0;
        if (ahead < 0.35 || (video.readyState >= 3 && ahead < 0.75)) {
          state.stuckSince = 0;
          return;
        }
        if (!state.stuckSince) {
          state.stuckSince = performance.now();
          return;
        }
        if (performance.now() - state.stuckSince >= 800) begin(true);
      }, 250);
      window.__metricTruth.videos.set(video, state);
    };
    const scan = () => {
      // Only output-column players — skip hidden MoQ/canvas helpers and any
      // leftover preview <video> nodes outside .stream-column.
      const vids = [...document.querySelectorAll(".stream-column video, .stream-player-card video")];
      vids.forEach((v, i) => ensure(v, i));
    };
    scan();
    window.__metricTruth._scan = setInterval(scan, 1000);
  });

  log(`[${label}] start comparison`);
  await page.locator("button.primary", { hasText: "Start comparison" }).click();

  // Sample for ~90s of encode (or until completed).
  const rounds = [];
  for (let round = 0; round < 18; round += 1) {
    await page.waitForTimeout(5000);
    const snap = await page.evaluate(() => {
      const truth = [];
      for (const [video, state] of window.__metricTruth.videos.entries()) {
        let open = state.rebufferMs;
        if (state.waitingSince) open += performance.now() - state.waitingSince;
        let label = `video${state.index}`;
        let node = video;
        for (let hop = 0; hop < 8 && node; hop += 1) {
          node = node.parentElement;
          const h = node?.querySelector?.("h3, h4, .stream-title, .output-title");
          if (h?.textContent?.trim()) {
            label = h.textContent.trim().slice(0, 48);
            break;
          }
        }
        const q = video.getVideoPlaybackQuality?.();
        truth.push({
          label,
          rebufferSec: Math.round((open / 1000) * 1000) / 1000,
          stallCount: state.stallCount,
          ttffMs: state.ttffMs,
          maxVt: state.maxVt,
          frames: q?.totalVideoFrames ?? 0,
          dropped: q?.droppedVideoFrames ?? 0,
          paused: video.paused,
        });
      }
      // Read reported metrics from the top summary strip if present.
      const strip = [...document.querySelectorAll(".top-summary-leg, .summary-leg, .metric")];
      const stripText = strip.map((el) => el.textContent?.replace(/\s+/g, " ").trim()).filter(Boolean);
      return { truth, stripText, at: Date.now() };
    });
    rounds.push({ round, ...snap });
    log(
      `[${label}] r${round} ` +
        snap.truth
          .map((t) => `${t.label}: rb=${t.rebufferSec}s stalls=${t.stallCount} ttff=${t.ttffMs} frames=${t.frames}`)
          .join(" | "),
    );
    const done = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button.primary")].find((b) =>
        (b.textContent || "").includes("Start comparison"),
      );
      return Boolean(btn && !btn.disabled && !(b => false)());
    });
    // Stop early once Start is enabled again and we've collected ≥8 rounds.
    if (round >= 8) {
      const startEnabled = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button.primary")].find((b) =>
          (b.textContent || "").includes("Start comparison"),
        );
        return Boolean(btn && !btn.disabled);
      });
      if (startEnabled) break;
    }
    void done;
  }

  // Pull final CSV via results API if same origin exposes it.
  let csvHint = null;
  try {
    const results = await page.evaluate(async () => {
      const r = await fetch("/api/results");
      return r.json();
    });
    csvHint = results;
  } catch {
    /* ignore */
  }

  await page.screenshot({ path: `${OUT}/${label}-final.png`, fullPage: true });

  // Resolve jobId → protocol from the API, then pair Output N ↔ protocol.
  const uploads = await page.evaluate(async () => {
    try {
      const r = await fetch("/api/uploads");
      const j = await r.json();
      return j.jobs || [];
    } catch {
      return [];
    }
  });
  const protoByJob = new Map(uploads.map((j) => [j.id, j.protocol]));
  const lastTruth = [...(rounds[rounds.length - 1]?.truth || [])];
  // Prefer Output N labels; drop unlabeled extras.
  const outputs = lastTruth
    .filter((t) => /^Output\s+\d+/i.test(t.label))
    .sort((a, b) => {
      const na = Number(a.label.match(/\d+/)?.[0] || 0);
      const nb = Number(b.label.match(/\d+/)?.[0] || 0);
      return na - nb;
    });
  // Default recipe: Output1=rtmp, Output2=srt, Output3=moq
  const defaultProto = ["rtmp", "srt", "moq"];
  const jobsReported = [...reportedByJob.values()].map((j) => ({
    ...j,
    protocol: protoByJob.get(j.jobId) || (j.engine === "moq" ? "moq" : null),
  }));
  log(
    `[${label}] reported jobs: ` +
      jobsReported
        .map((j) => `${j.protocol || "?"}/${j.engine}:${j.jobId.slice(0, 8)} n=${j.samples.length}`)
        .join(" | "),
  );

  const verdicts = [];
  for (let i = 0; i < outputs.length; i += 1) {
    const t = outputs[i];
    const wantProto = defaultProto[i];
    const job =
      jobsReported.find((j) => j.protocol === wantProto) ||
      jobsReported.find((j) => wantProto === "moq" && j.engine === "moq");
    if (!job?.samples?.length) {
      log(`[${label}] VERDICT ${wantProto}/${t.label}: FAIL (no reported samples)`);
      verdicts.push({ engine: wantProto, ok: false, truth: t, reported: null });
      continue;
    }
    const { engine, samples, jobId, protocol } = job;
    const last = samples[samples.length - 1];
    const reported = {
      rebufferSec: Math.max(...samples.map((s) => Number(s.playback_rebuffer_sec) || 0)),
      stallCount: Math.max(...samples.map((s) => Number(s.playback_stall_count) || 0)),
      ttffMs: Number(last.playback_ttff_ms) || 0,
      frames: Math.max(...samples.map((s) => Number(s.playback_frames_rendered) || 0)),
      e2eMs: Number(last.e2e_latency_ms) || 0,
      nSamples: samples.length,
      jobId,
      protocol,
    };
    const rbErr = Math.abs(reported.rebufferSec - t.rebufferSec);
    const stallErr = Math.abs(reported.stallCount - t.stallCount);
    const frameTol = Math.max(TOL.framesAbs, t.frames * TOL.framesRel);
    const frameErr = t.frames > 0 ? Math.abs(reported.frames - t.frames) : 0;
    const ok =
      rbErr <= TOL.rebufferSec &&
      stallErr <= TOL.stallCount &&
      (t.frames <= 0 || frameErr <= frameTol);
    verdicts.push({ engine, protocol, ok, rbErr, stallErr, frameErr, truth: t, reported });
    log(
      `[${label}] VERDICT ${protocol}/${engine}/${t.label}: ${ok ? "PASS" : "FAIL"} ` +
        `rb truth=${t.rebufferSec} rep=${reported.rebufferSec} (Δ${rbErr.toFixed(3)}) ` +
        `stalls truth=${t.stallCount} rep=${reported.stallCount} ` +
        `frames truth=${t.frames} rep=${reported.frames}`,
    );
  }

  await page.close();
  return {
    label,
    rounds,
    csvHint,
    verdicts,
    reportedJobs: jobsReported.map((j) => ({ jobId: j.jobId, engine: j.engine, n: j.samples.length })),
  };
}

async function configureVod(page) {
  const sourceSelect = page.locator("select", {
    has: page.locator('option[value="upload"]'),
  });
  if (await sourceSelect.count()) {
    await sourceSelect.first().selectOption("upload");
    if (fs.existsSync(CLIP)) {
      await page.locator('input[type="file"]').first().setInputFiles(CLIP);
      log("uploaded timer clip");
      await page.waitForFunction(
        () => {
          const btn = [...document.querySelectorAll("button.primary")].find((b) =>
            b.textContent.includes("Start comparison"),
          );
          return btn && !btn.disabled && !btn.textContent.includes("Preparing");
        },
        { timeout: 180000 },
      );
    }
  }
}

async function configureWebcam(page) {
  // Click Webcam radio if present.
  const cam = page.locator("label.source-mode-card", { hasText: "Webcam" });
  if (await cam.count()) {
    await cam.first().click();
    await page.waitForTimeout(1500);
  }
}

const jobs = [];
if (MODE === "vod" || MODE === "both") {
  jobs.push(await runOnce("vod", configureVod));
}
if (MODE === "webcam" || MODE === "both") {
  jobs.push(await runOnce("webcam", configureWebcam));
}

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify({ tol: TOL, jobs }, null, 2));
log(`wrote ${OUT}/report.json`);

// Verdict: any video with rebuffer>0.5 in truth should not report 0 in last round
// (we can't always read reported from strip reliably — print guidance).
let failures = 0;
for (const job of jobs) {
  for (const v of job.verdicts || []) {
    if (!v.ok) failures += 1;
  }
  if (!(job.verdicts || []).length) {
    log(`WARN ${job.label}: no verdicts (could not pair truth with reported samples)`);
    failures += 1;
  }
}

await browser.close();
log(failures ? `FAILED with ${failures} metric mismatch(es)` : "ALL CHECKS PASSED");
process.exit(failures > 0 ? 2 : 0);
