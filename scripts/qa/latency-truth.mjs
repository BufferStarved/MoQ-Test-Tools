// Latency ground-truth harness: upload a burnt-in-timer clip, run the 3-leg
// comparison on prod, and capture each <video>'s pixels alongside server time.
// True e2e per leg = (serverNow - first_sample_at_epoch) - displayed clip time.
// Usage: node latency-truth.mjs [baseUrl] [clipPath]
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] ?? "https://moq.sean-mccarthy.net";
const CLIP = process.argv[3] ?? "/tmp/timer_test.mp4";
const OUT_DIR = "/tmp/latency-truth";
fs.mkdirSync(OUT_DIR, { recursive: true });

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required", "--enable-features=WebTransport"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
page.on("pageerror", (err) => log(`pageerror: ${err.message}`));

log(`open ${BASE}`);
await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForFunction(
  () => {
    const btn = document.querySelector(".benchmark-start-row button.primary");
    return Boolean(btn && !btn.disabled);
  },
  { timeout: 120000 },
);

// Select "Upload your own file…" and attach the timer clip.
const sourceSelect = page.locator("select", {
  has: page.locator('option[value="upload"]'),
});
await sourceSelect.first().selectOption("upload");
await page.locator('input[type="file"]').first().setInputFiles(CLIP);
log("uploading clip...");
// Wait until the media is uploaded (start button enabled again + not "Preparing").
await page.waitForFunction(
  () => {
    const btn = document.querySelector(".benchmark-start-row button.primary");
    return btn && !btn.disabled && !(btn.textContent || "").includes("Preparing");
  },
  { timeout: 180000 },
);

log("start comparison");
await page.locator(".benchmark-start-row button.primary").click();

// Helper: measure server clock offset (serverEpochMs - Date.now()) in-page.
async function serverOffsetMs() {
  return page.evaluate(async () => {
    const t0 = Date.now();
    const r = await fetch("/api/time", { cache: "no-store" });
    const j = await r.json();
    const t1 = Date.now();
    return j.epoch * 1000 - (t0 + t1) / 2;
  });
}
const offsets = [];
for (let i = 0; i < 3; i += 1) offsets.push(await serverOffsetMs());
offsets.sort((a, b) => a - b);
const offset = offsets[1];
log(`server clock offset: ${offset.toFixed(0)}ms`);

// Capture loop: every 10s grab all video frames + playheads at a server time.
const captures = [];
for (let round = 0; round < 12; round += 1) {
  await page.waitForTimeout(10000);
  const snap = await page.evaluate(() => {
    const out = [];
    const vids = [...document.querySelectorAll("video")];
    for (let i = 0; i < vids.length; i += 1) {
      const v = vids[i];
      let label = `video${i}`;
      let node = v;
      for (let hop = 0; hop < 8 && node; hop += 1) {
        node = node.parentElement;
        const h = node?.querySelector?.("h3, h4, .stream-title, .output-title");
        if (h && h.textContent.trim()) {
          label = h.textContent.trim().slice(0, 40);
          break;
        }
      }
      let dataUrl = null;
      try {
        if (v.videoWidth > 0) {
          const c = document.createElement("canvas");
          c.width = v.videoWidth;
          c.height = v.videoHeight;
          c.getContext("2d").drawImage(v, 0, 0);
          dataUrl = c.toDataURL("image/jpeg", 0.85);
        }
      } catch (err) {
        dataUrl = `ERR:${err.message}`;
      }
      out.push({ label, ct: v.currentTime, paused: v.paused, ready: v.readyState, dataUrl });
    }
    return { atMs: Date.now(), vids: out };
  });
  const serverAtMs = snap.atMs + offset;
  const rec = { round, serverAtMs, vids: [] };
  for (const v of snap.vids) {
    const entry = { label: v.label, ct: v.ct, paused: v.paused, ready: v.ready };
    if (v.dataUrl && v.dataUrl.startsWith("data:")) {
      const file = `${OUT_DIR}/r${String(round).padStart(2, "0")}_${v.label.replace(/[^a-z0-9]+/gi, "_")}.jpg`;
      fs.writeFileSync(file, Buffer.from(v.dataUrl.split(",")[1], "base64"));
      entry.file = file;
    } else if (v.dataUrl) {
      entry.err = v.dataUrl;
    }
    rec.vids.push(entry);
  }
  captures.push(rec);
  log(
    `round=${round} serverAt=${(serverAtMs / 1000).toFixed(2)} ` +
      rec.vids.map((v) => `${v.label}: ct=${v.ct.toFixed(2)}${v.paused ? " paused" : ""}`).join(" | "),
  );
}

fs.writeFileSync(`${OUT_DIR}/captures.json`, JSON.stringify(captures, null, 2));
await page.screenshot({ path: `${OUT_DIR}/final-page.png`, fullPage: true });
log(`wrote ${OUT_DIR}/captures.json`);
await browser.close();
