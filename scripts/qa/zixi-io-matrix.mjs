#!/usr/bin/env node
/**
 * Zixi input × playback matrix smoke test.
 *
 * Supported (UI): SRT + RTMP × HLS + MPEG-TS
 *
 * Usage:
 *   node scripts/qa/zixi-io-matrix.mjs
 *   FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg PUSH_SEC=20 node scripts/qa/zixi-io-matrix.mjs
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";

const ZIXI_HOST = process.env.ZIXI_HOST || "35.222.33.58";
const HTTP_PORT = process.env.ZIXI_HTTP_PORT || "7777";
const RTMP_PORT = process.env.ZIXI_RTMP_PORT || "1935";
const SRT_PORT = process.env.ZIXI_SRT_PORT || "10080";
const PUSH_SEC = Number(process.env.PUSH_SEC || "24");

function resolveFfmpeg() {
  const candidates = [
    process.env.FFMPEG,
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
    "ffmpeg",
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "ffmpeg" || existsSync(c)) return c;
  }
  return "ffmpeg";
}

const FFMPEG = resolveFfmpeg();

/** Match Python quote(..., safe=':#!/@=,') used by with_srt_stream_id. */
function zixiSrtPublishUrl() {
  const streamid = encodeURIComponent("#!::r=SRT Test,m=publish").replace(
    /%3A/gi,
    ":",
  ).replace(/%23/g, "#").replace(/%21/g, "!").replace(/%2F/g, "/").replace(/%40/g, "@").replace(/%3D/g, "=").replace(/%2C/g, ",");
  // Spaces still encoded as %20 — good.
  return `srt://${ZIXI_HOST}:${SRT_PORT}?mode=caller&latency=200000&streamid=${streamid}`;
}

const SRT_STREAM = "SRT Test";
/** Fast HLS on primary wedges; EC is the supported browser playback stream. */
const SRT_HLS_STREAM = "SRT Test EC";
const RTMP_STREAM = "benchmark";

const cases = [
  {
    id: "srt_hls",
    ingest: "srt",
    playback: "hls",
    publishUrl: zixiSrtPublishUrl(),
    playUrl: `http://${ZIXI_HOST}:${HTTP_PORT}/playback.m3u8?stream=${encodeURIComponent(SRT_HLS_STREAM)}`,
  },
  {
    id: "srt_mpegts",
    ingest: "srt",
    playback: "mpegts",
    publishUrl: zixiSrtPublishUrl(),
    playUrl: `http://${ZIXI_HOST}:${HTTP_PORT}/${encodeURIComponent(SRT_HLS_STREAM)}.ts`,
  },
  {
    id: "rtmp_hls",
    ingest: "rtmp",
    playback: "hls",
    publishUrl: `rtmp://${ZIXI_HOST}:${RTMP_PORT}/live/${RTMP_STREAM}`,
    playUrl: `http://${ZIXI_HOST}:${HTTP_PORT}/playback.m3u8?stream=${encodeURIComponent(RTMP_STREAM)}`,
  },
  {
    id: "rtmp_mpegts",
    ingest: "rtmp",
    playback: "mpegts",
    publishUrl: `rtmp://${ZIXI_HOST}:${RTMP_PORT}/live/${RTMP_STREAM}`,
    playUrl: `http://${ZIXI_HOST}:${HTTP_PORT}/${encodeURIComponent(RTMP_STREAM)}.ts`,
  },
];

function log(msg) {
  console.log(msg);
}

function startPublish(caseRow) {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=1280x720:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "main",
    "-preset",
    "veryfast",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-b:v",
    "2500k",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-t",
    String(PUSH_SEC),
  ];
  if (caseRow.ingest === "rtmp") {
    args.push("-f", "flv", "-flvflags", "no_duration_filesize", caseRow.publishUrl);
  } else {
    args.push("-f", "mpegts", caseRow.publishUrl);
  }
  const child = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let exitCode = null;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 6000) stderr = stderr.slice(-6000);
  });
  child.on("error", (err) => {
    stderr += `\nspawn error: ${err.message}`;
    exitCode = -1;
  });
  child.on("close", (code) => {
    exitCode = code;
  });
  return {
    child,
    stderr: () => stderr,
    wait: () =>
      new Promise((resolve) => {
        if (exitCode !== null) {
          resolve(exitCode);
          return;
        }
        child.once("close", (code) => resolve(code));
      }),
  };
}

function mediaSequence(body) {
  const m = body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  return m ? Number(m[1]) : null;
}

async function fetchText(url, timeoutMs = 5000) {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { res, body };
}

async function probeHls(url, deadlineMs) {
  const end = Date.now() + deadlineMs;
  let last = { ok: false, code: 0, detail: "not probed" };
  let firstSeq = null;
  while (Date.now() < end) {
    try {
      const { res, body } = await fetchText(url);
      if (!(res.ok && body.includes("#EXTM3U"))) {
        last = { ok: false, code: res.status, detail: body.slice(0, 100).replace(/\s+/g, " ") };
        await sleep(1000);
        continue;
      }
      const seq = mediaSequence(body);
      const target = Number((body.match(/#EXT-X-TARGETDURATION:(\d+)/) || [])[1] || 0);
      const hasSeg = body.split("\n").some((l) => l.trim() && !l.startsWith("#"));
      // Stale Zixi leftovers often show huge TARGETDURATION after dead publishes.
      if (target > 30) {
        last = {
          ok: false,
          code: res.status,
          detail: `stale playlist TARGETDURATION=${target} seq=${seq}`,
        };
        await sleep(1000);
        continue;
      }
      if (firstSeq === null && seq !== null) firstSeq = seq;
      // Require sequence advance OR a fresh short target + segment line.
      if (hasSeg && seq !== null && firstSeq !== null && seq > firstSeq) {
        return { ok: true, code: res.status, detail: `live playlist seq ${firstSeq}→${seq}` };
      }
      if (hasSeg && target > 0 && target <= 10 && Date.now() + 8000 < end) {
        // Keep waiting a bit for seq advance; if near deadline accept short target.
      }
      if (hasSeg && target > 0 && target <= 10 && Date.now() > end - 2000) {
        return {
          ok: true,
          code: res.status,
          detail: `playlist target=${target}s seq=${seq} (no advance before deadline)`,
        };
      }
      last = {
        ok: false,
        code: res.status,
        detail: `waiting for live edge (target=${target} seq=${seq})`,
      };
    } catch (err) {
      last = { ok: false, code: 0, detail: err instanceof Error ? err.message : String(err) };
    }
    await sleep(1000);
  }
  return last;
}

async function probeMpegTs(url, deadlineMs) {
  const end = Date.now() + deadlineMs;
  let last = { ok: false, code: 0, detail: "not probed", bytes: 0 };
  while (Date.now() < end) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(4500),
      });
      if (!res.ok || !res.body) {
        last = { ok: false, code: res.status, detail: `HTTP ${res.status}`, bytes: 0 };
        await sleep(1000);
        continue;
      }
      const reader = res.body.getReader();
      let bytes = 0;
      let sync = false;
      const readDeadline = Date.now() + 3500;
      while (Date.now() < readDeadline && bytes < 188 * 80) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) {
          bytes += value.length;
          if (value[0] === 0x47) sync = true;
        }
      }
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      if (res.ok && bytes >= 188 * 4 && sync) {
        return { ok: true, code: res.status, detail: `received ${bytes}B TS (sync ok)`, bytes };
      }
      last = {
        ok: false,
        code: res.status,
        detail:
          bytes === 0
            ? "HTTP 200 but 0 bytes (empty/hanging TS)"
            : `only ${bytes}B sync=${sync}`,
        bytes,
      };
    } catch (err) {
      last = {
        ok: false,
        code: 0,
        detail: err instanceof Error ? err.message : String(err),
        bytes: 0,
      };
    }
    await sleep(1000);
  }
  return last;
}

async function runCase(caseRow) {
  log(`\n=== ${caseRow.id} (${caseRow.ingest} → ${caseRow.playback}) ===`);
  log(`publish: ${caseRow.publishUrl}`);
  log(`play:    ${caseRow.playUrl}`);
  const pub = startPublish(caseRow);
  await sleep(5000);
  if (pub.child.exitCode !== null && pub.child.exitCode !== 0) {
    const detail = `ffmpeg exited ${pub.child.exitCode} before playback probe`;
    log(`FAIL ${caseRow.id}: ${detail}`);
    log(`  ffmpeg: ${pub.stderr().trim().split("\n").slice(-4).join(" | ")}`);
    return { id: caseRow.id, ok: false, probe: { detail }, publishExit: pub.child.exitCode };
  }
  const probe =
    caseRow.playback === "hls"
      ? await probeHls(caseRow.playUrl, Math.max(8, PUSH_SEC - 8) * 1000)
      : await probeMpegTs(caseRow.playUrl, Math.max(8, PUSH_SEC - 8) * 1000);
  // Stop publisher early once we have a verdict to free the shared input.
  try {
    pub.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const code = await pub.wait();
  log(
    probe.ok
      ? `PASS ${caseRow.id}: ${probe.detail}`
      : `FAIL ${caseRow.id}: ${probe.detail} (ffmpeg exit ${code})`,
  );
  if (!probe.ok) {
    const tail = pub.stderr().trim().split("\n").slice(-4).join(" | ");
    if (tail) log(`  ffmpeg: ${tail}`);
  }
  return { id: caseRow.id, ok: probe.ok, probe, publishExit: code };
}

async function main() {
  log(`Zixi I/O matrix @ ${ZIXI_HOST} (push ${PUSH_SEC}s, ffmpeg=${FFMPEG})`);
  const results = [];
  for (const row of cases) {
    results.push(await runCase(row));
    await sleep(3000);
  }

  log("\n=== Summary ===");
  for (const r of results) {
    log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(14)}  ${r.probe.detail}`);
  }
  const failed = results.filter((r) => !r.ok);
  log(failed.length ? `\n${failed.length}/${results.length} failed` : `\n${results.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
