// Drive the real prod UI, run a 3-leg VOD comparison, and measure playback
// smoothness per leg by sampling every <video> playhead once per second.
// Usage: node smoothness-verify.mjs [baseUrl]
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "https://moq.sean-mccarthy.net";
const SAMPLE_SECONDS = 130;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

const browser = await chromium.launch({
  headless: true,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-features=WebTransport",
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 2400 } });
page.on("pageerror", (err) => log(`pageerror: ${err.message}`));

log(`open ${BASE}`);
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45000 });

const startBtn = page.locator(".benchmark-start-row button.primary");
await startBtn.waitFor({ state: "visible", timeout: 45000 });
// Wait for bootstrap to finish (button enabled).
await page.waitForFunction(
  () => {
    const btn = document.querySelector(".benchmark-start-row button.primary");
    return btn && !btn.disabled;
  },
  { timeout: 60000 },
);

// Verify the RTMP output card advertises Fast HLS as the selected player.
const playerSelects = await page.evaluate(() => {
  const out = [];
  for (const sel of document.querySelectorAll("select")) {
    const options = [...sel.options].map((o) => o.textContent.trim());
    if (options.some((t) => t.includes("Fast HLS") || t.includes("MoQ Playback"))) {
      out.push({ selected: sel.options[sel.selectedIndex]?.textContent.trim(), options });
    }
  }
  return out;
});
console.log("player-selects:", JSON.stringify(playerSelects, null, 1));

log("start comparison");
await startBtn.click();

// Sample playheads once per second.
const series = [];
for (let t = 0; t < SAMPLE_SECONDS; t += 1) {
  const snap = await page.evaluate(() => {
    const vids = [...document.querySelectorAll("video")].map((v, i) => {
      let label = `video${i}`;
      let node = v;
      for (let hop = 0; hop < 8 && node; hop += 1) {
        node = node.parentElement;
        const h = node?.querySelector?.("h3, h4, .stream-title, .output-title");
        if (h && h.textContent.trim()) {
          label = h.textContent.trim().slice(0, 60);
          break;
        }
      }
      return {
        label,
        ct: Number(v.currentTime.toFixed(3)),
        ready: v.readyState,
        paused: v.paused,
        w: v.videoWidth,
      };
    });
    const statuses = [...document.querySelectorAll(".player-status, .status-line")]
      .map((n) => n.textContent.trim())
      .slice(0, 6);
    return { vids, statuses };
  });
  series.push({ t, ...snap });
  if (t % 15 === 0) {
    log(
      `t=${t}s ` +
        snap.vids.map((v) => `${v.label}: ct=${v.ct} rs=${v.ready}${v.paused ? " paused" : ""}`).join(" | "),
    );
  }
  await page.waitForTimeout(1000);
}

// Analyze freezes per leg: consecutive 1s samples with identical currentTime
// while the video had started (ct > 0) and hadn't ended.
const legs = {};
for (const snap of series) {
  for (const v of snap.vids) {
    (legs[v.label] ??= []).push({ t: snap.t, ct: v.ct, paused: v.paused });
  }
}
const summary = {};
for (const [label, points] of Object.entries(legs)) {
  let freezes = [];
  let cur = null;
  let maxCt = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const p = points[i];
    maxCt = Math.max(maxCt, p.ct);
    const frozen = p.ct > 0 && p.ct === prev.ct && p.ct < maxCt + 0.001 && maxCt < 59.5;
    if (frozen) {
      if (cur) cur.end = p.t;
      else cur = { start: prev.t, end: p.t };
    } else if (cur) {
      freezes.push(cur);
      cur = null;
    }
  }
  if (cur) freezes.push(cur);
  freezes = freezes.filter((f) => f.end - f.start >= 2);
  const frozenSec = freezes.reduce((acc, f) => acc + (f.end - f.start), 0);
  summary[label] = {
    firstPlayheadAt: points.find((p) => p.ct > 0)?.t ?? null,
    maxCt,
    freezeRuns: freezes,
    totalFrozenSec: frozenSec,
  };
}
console.log("SMOOTHNESS_SUMMARY " + JSON.stringify(summary, null, 2));

await page.screenshot({ path: "/tmp/smoothness-final.png", fullPage: true });
log("screenshot: /tmp/smoothness-final.png");
await browser.close();
