#!/usr/bin/env node
/**
 * Minimal LL-HLS playback probe: plays a MediaMTX (or any) HLS URL in
 * headless Chrome with the same hls.js configuration the app uses, and logs
 * playhead advancement, buffered ranges, readyState, and hls.js errors once
 * a second. Isolates packager+player behavior from the webcam bridge and
 * the app UI.
 *
 * Usage:
 *   node hls-probe.mjs [--url=http://34.9.217.178:8888/benchmark/index.m3u8] [--duration=60] [--ll=1]
 */
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

function argValue(flag, fallback) {
  const prefix = `--${flag}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const url = argValue("url", "http://34.9.217.178:8888/benchmark/index.m3u8");
const watchSec = Number(argValue("duration", "60"));
const lowLatencyMode = argValue("ll", "1") === "1";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hlsJsPath = path.join(repoRoot, "web", "frontend", "node_modules", "hls.js", "dist", "hls.min.js");

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const page = await browser.newPage();
  page.on("console", (msg) => console.log(`[page] ${msg.text()}`));

  await page.setContent(`<video id="v" muted autoplay playsinline style="width:640px"></video>`);
  await page.addScriptTag({ path: hlsJsPath });

  await page.evaluate(
    ({ url, lowLatencyMode }) => {
      const video = document.getElementById("v");
      // Mirrors HlsPlayer.tsx: LL-HLS uses hls.js's own part-level live sync.
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode,
        ...(lowLatencyMode
          ? { maxLiveSyncPlaybackRate: 1.5, maxBufferLength: 12, maxMaxBufferLength: 30 }
          : { liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, maxLiveSyncPlaybackRate: 1.5, maxBufferLength: 20 }),
        backBufferLength: 30,
      });
      window.__stats = { errors: [], events: [] };
      hls.on(Hls.Events.ERROR, (_e, d) => {
        window.__stats.errors.push(
          `${(performance.now() / 1000).toFixed(1)}s fatal=${d.fatal} ${d.type}/${d.details} http=${d.response?.code ?? "-"}`,
        );
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      window.__hls = hls;
      video.play().catch(() => {});
    },
    { url, lowLatencyMode },
  );

  let lastTime = -1;
  let frozenSec = 0;
  const samples = [];
  for (let t = 0; t < watchSec; t += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = await page.evaluate(() => {
      const video = document.getElementById("v");
      const ranges = [];
      for (let i = 0; i < video.buffered.length; i += 1) {
        ranges.push(`[${video.buffered.start(i).toFixed(2)},${video.buffered.end(i).toFixed(2)}]`);
      }
      return {
        t: video.currentTime,
        rs: video.readyState,
        paused: video.paused,
        seeking: video.seeking,
        rate: video.playbackRate,
        liveSync: window.__hls?.liveSyncPosition ?? null,
        ranges: ranges.join(" "),
        errors: window.__stats.errors.splice(0),
      };
    });
    const advanced = s.t - lastTime;
    if (advanced < 0.2) frozenSec += 1;
    lastTime = s.t;
    samples.push(advanced);
    const behind = s.liveSync != null ? (s.liveSync - s.t).toFixed(2) : "-";
    console.log(
      `t+${String(t + 1).padStart(3)}s ct=${s.t.toFixed(2)} d=${advanced.toFixed(2)} rs=${s.rs} paused=${s.paused} seeking=${s.seeking} rate=${s.rate} behind=${behind} buf=${s.ranges}`,
    );
    for (const err of s.errors) console.log(`   err: ${err}`);
  }
  const advancing = samples.filter((d) => d > 0.5).length;
  console.log(
    `\nSUMMARY url=${url} ll=${lowLatencyMode} advancing=${advancing}/${samples.length}s frozen=${frozenSec}s`,
  );
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
