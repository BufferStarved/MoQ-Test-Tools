#!/usr/bin/env node
/**
 * Headed MoQ draft-18 paint smoke. Playwright + system Chrome, new profile.
 * Success = playback_frames_rendered climbing (>0 then higher).
 *
 *   UI_URL=http://127.0.0.1:5173 node scripts/qa/headed-moq-d18.mjs
 */
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(
  new URL("../../.cache/matrix-playwright/package.json", import.meta.url),
);
const { chromium } = require("playwright");

const API = process.env.API_URL || "https://moq.sean-mccarthy.net";
const UI = process.env.UI_URL || "http://127.0.0.1:5174";
const CHROME =
  process.env.CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REGIONS = [
  {
    id: "gcp_central",
    label: "GCP Central (Iowa / public west)",
    preset: "moq_gcp_relay_d18",
    outputs: "west_d18",
  },
  {
    id: "gcp_east",
    label: "GCP East",
    preset: "moq_gcp_east_relay_d18",
    outputs: "east_moq",
  },
  {
    id: "linode_east",
    label: "Linode East",
    preset: "moq_linode_relay_d18",
    outputs: "linode_moq",
  },
];

const FILE_DURATION = Number(process.env.FILE_DURATION || 22);
const WAIT_MS = Number(process.env.WAIT_MS || 28000);
const ONLY_REGION = (process.env.REGION || "").trim();
const ONLY_PATH = (process.env.PATHS || "browser,file").split(",").map((s) => s.trim()).filter(Boolean);

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "User-Agent": UA,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  return data;
}

function lastRendered(job) {
  const samples = job.samples || [];
  let max = 0;
  let last = 0;
  for (const s of samples) {
    const n = Number(s.playback_frames_rendered || 0);
    last = n;
    if (n > max) max = n;
  }
  return { last, max, n: samples.length };
}

async function waitRendered(jobId, ms) {
  const deadline = Date.now() + ms;
  let best = { last: 0, max: 0, n: 0 };
  let climbed = false;
  let first = 0;
  while (Date.now() < deadline) {
    const job = await api("GET", `/api/uploads/${jobId}`);
    best = lastRendered(job);
    if (best.max > 0 && first === 0) first = best.max;
    if (best.max > first && first > 0) climbed = true;
    if (best.max > 0 && climbed) {
      return { ok: true, climbed: true, ...best, status: job.status, error: job.error };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  const job = await api("GET", `/api/uploads/${jobId}`);
  best = lastRendered(job);
  return {
    ok: best.max > 0,
    climbed: best.max > (first || 0) && best.max > 0,
    ...best,
    status: job.status,
    error: job.error,
  };
}

async function stopJob(jobId) {
  try {
    await api("POST", `/api/uploads/${jobId}/stop`);
  } catch {
    /* already done */
  }
}

async function hardReload(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
}

async function runFile(region, context) {
  const job = await api("POST", "/api/uploads", {
    media_path: "dummy.mp4",
    preset_id: region.preset,
    duration_sec: FILE_DURATION,
    publisher_host: "cloud",
    encode_ladder: "720p",
    target_latency_ms: 400,
  });
  const jobId = job.id;
  console.log(`  file job ${jobId.slice(0, 8)} ${region.preset}`);
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`  pageerror ${String(err).slice(0, 160)}`));
  const started = await api("GET", `/api/uploads/${jobId}`);
  if (started.status === "failed" || started.error) {
    await page.close().catch(() => undefined);
    return {
      path: "file/ffmpeg",
      jobId,
      ok: false,
      climbed: false,
      last: 0,
      max: 0,
      n: 0,
      error: started.error || started.status,
    };
  }
  const url = `${UI}/?harnessJob=${encodeURIComponent(jobId)}&playback=moq&_=${Date.now()}`;
  await hardReload(page, url);
  const paint = await waitRendered(jobId, WAIT_MS);
  await stopJob(jobId);
  await page.close();
  return { path: "file/ffmpeg", jobId, ...paint };
}

async function runBrowser(region, context) {
  const page = await context.newPage();
  const created = [];
  page.on("pageerror", (err) => console.log(`  pageerror ${String(err).slice(0, 160)}`));
  page.on("response", async (res) => {
    try {
      if (
        res.request().method() === "POST" &&
        res.url().includes("/api/uploads") &&
        !res.url().includes("playback") &&
        !res.url().includes("stop") &&
        res.status() < 400
      ) {
        const body = await res.json();
        if (body?.id) created.push(body.id);
      }
    } catch {
      /* ignore */
    }
  });
  const url = `${UI}/?source=browser&outputs=${region.outputs}&_=${Date.now()}`;
  await hardReload(page, url);
  await page.waitForSelector(".hero-start-button, .benchmark-start-row button.primary, button.primary", {
    timeout: 30000,
  });
  await page.waitForTimeout(800);
  const apiLabel = await page.locator(".hero-api-status").textContent().catch(() => "");
  console.log(`  ui api=${apiLabel.trim()}`);
  const start = page.locator("button.primary").filter({ hasText: /^Start$/ }).first();
  if (!(await start.count())) {
    const html = await page.locator("h1, .error, .benchmark-start-error, .hero-api-status").allTextContents();
    await page.close();
    return {
      path: "browser LOC",
      jobId: "",
      ok: false,
      climbed: false,
      last: 0,
      max: 0,
      n: 0,
      error: `no Start button (${html.join(" | ").slice(0, 200)})`,
    };
  }
  if (await start.isDisabled()) {
    const hint = await page
      .locator(".benchmark-start-error, .field-hint")
      .first()
      .textContent()
      .catch(() => "");
    await page.close();
    return {
      path: "browser LOC",
      jobId: "",
      ok: false,
      climbed: false,
      last: 0,
      max: 0,
      n: 0,
      error: `Start disabled: ${hint}`,
    };
  }
  await start.click();
  const deadline = Date.now() + 15000;
  while (!created.length && Date.now() < deadline) {
    await page.waitForTimeout(300);
  }
  if (!created.length) {
    const recent = await api("GET", "/api/uploads");
    const items = Array.isArray(recent) ? recent : recent.jobs || recent.uploads || [];
    const browserJobs = items.filter(
      (j) => (j.media_path || "").includes("device:browser") && j.preset_id === region.preset,
    );
    if (browserJobs[0]) created.push(browserJobs[0].id);
  }
  const jobId = created[0] || "";
  if (!jobId) {
    await page.close();
    return {
      path: "browser LOC",
      jobId: "",
      ok: false,
      climbed: false,
      last: 0,
      max: 0,
      n: 0,
      error: "no job id after Start",
    };
  }
  console.log(`  browser job ${jobId.slice(0, 8)} ${region.outputs}`);
  const paint = await waitRendered(jobId, WAIT_MS);
  try {
    await page
      .locator("button.stop-webcam-button, button.secondary-button")
      .filter({ hasText: /Stop/ })
      .first()
      .click({ timeout: 3000 });
  } catch {
    await stopJob(jobId);
  }
  await page.close();
  return { path: "browser LOC", jobId, ...paint };
}

async function main() {
  const health = await api("GET", "/api/health");
  console.log(`health ${JSON.stringify(health)} UI=${UI}`);
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "moq-headed-")), {
    executablePath: CHROME,
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1100 },
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--enable-features=WebTransport",
      "--ignore-certificate-errors",
      "--disable-dev-shm-usage",
      "--mute-audio",
    ],
  });
  const rows = [];
  const selected = ONLY_REGION ? REGIONS.filter((r) => r.id === ONLY_REGION) : REGIONS;
  if (!selected.length) {
    throw new Error(`unknown REGION=${ONLY_REGION} (gcp_east|gcp_central|linode_east)`);
  }
  console.log(`regions ${selected.map((r) => r.id).join(",")} paths ${ONLY_PATH.join(",")}`);
  try {
    for (const region of selected) {
      if (ONLY_PATH.includes("file")) {
        console.log(`\n== ${region.label} file ==`);
        try {
          rows.push({ region: region.id, ...(await runFile(region, context)) });
        } catch (err) {
          rows.push({
            region: region.id,
            path: "file/ffmpeg",
            ok: false,
            climbed: false,
            last: 0,
            max: 0,
            error: String(err),
          });
        }
      }
      if (ONLY_PATH.includes("browser")) {
        console.log(`\n== ${region.label} browser ==`);
        try {
          rows.push({ region: region.id, ...(await runBrowser(region, context)) });
        } catch (err) {
          rows.push({
            region: region.id,
            path: "browser LOC",
            ok: false,
            climbed: false,
            last: 0,
            max: 0,
            error: String(err),
          });
        }
      }
    }
  } finally {
    await context.close();
  }
  console.log("\n======== PAINT TABLE ========");
  console.log(
    "region".padEnd(14),
    "path".padEnd(14),
    "ok".padEnd(6),
    "climb".padEnd(6),
    "rendered".padEnd(10),
    "job",
    "error",
  );
  for (const r of rows) {
    console.log(
      (r.region || "").padEnd(14),
      (r.path || "").padEnd(14),
      String(!!r.ok).padEnd(6),
      String(!!r.climbed).padEnd(6),
      String(r.max ?? 0).padEnd(10),
      (r.jobId || "").slice(0, 8),
      r.error || "",
    );
  }
  const failed = rows.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
