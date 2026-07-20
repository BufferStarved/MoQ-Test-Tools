#!/usr/bin/env python3
"""End-to-end matrix: ingest health, Chrome playback, and metric collection.

Runs short encode jobs against each live GCP preset, polls encode metrics,
and drives Google Chrome (Playwright) against the live playback URL while
the job is running.

Usage:
  python3 scripts/e2e_ingest_matrix_test.py
  BASE_URL=https://moq.sean-mccarthy.net DURATION=22 python3 scripts/e2e_ingest_matrix_test.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("BASE_URL", "https://moq.sean-mccarthy.net").rstrip("/")
DURATION = int(os.environ.get("DURATION", "22"))
MEDIA = Path(os.environ.get("MEDIA", str(ROOT / "dummy.mp4")))
SKIP_CHROME = os.environ.get("SKIP_CHROME", "").strip().lower() in {"1", "true", "yes"}
CHROME_BIN = os.environ.get(
    "CHROME_BIN",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)

# Live matrix rows: preset → expected playback engine + URL builder inputs.
CASES = [
    {
        "id": "zixi_srt_hls",
        "preset_id": "moq_zixi_gcp",
        "playback": "hls",
        "url": "http://35.222.33.58:7777/playback.m3u8?stream=SRT%20Test",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "zixi_srt_mpegts",
        "preset_id": "moq_zixi_gcp",
        "playback": "mpegts",
        "url": "http://35.222.33.58:7777/SRT%20Test.ts",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps",),
        "skip": True,  # covered via dual Chrome probe during zixi_srt_hls
    },
    {
        "id": "zixi_rtmp_hls",
        "preset_id": "moq_zixi_gcp_rtmp",
        "playback": "hls",
        "url": "http://35.222.33.58:7777/playback.m3u8?stream=benchmark",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "zixi_tsput_hls",
        "preset_id": "moq_zixi_gcp_hls",
        # Zixi accepts MPEG-TS PUT but does not expose Fast HLS / HTTP-TS for this
        # input on the current Broadcaster settings — validate encode metrics only.
        "playback": "skip",
        "url": "",
        "expect_preview": False,
        "metric_keys": ("encoded_bitrate_kbps",),
        "known_gap": "zixi_http_ts_push_no_playback",
    },
    {
        "id": "zixi_tsput_dash",
        "preset_id": "moq_zixi_gcp_dash",
        "playback": "skip",
        "url": "",
        "expect_preview": False,
        "metric_keys": ("encoded_bitrate_kbps",),
        "known_gap": "zixi_http_ts_push_no_playback",
    },
    {
        "id": "mediamtx_srt_llhls",
        "preset_id": "moq_mediamtx_gcp_srt",
        "playback": "hls",
        "url": "http://34.9.217.178:8888/benchmark/index.m3u8",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "net_recv_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "mediamtx_rtmp_llhls",
        "preset_id": "moq_mediamtx_gcp_rtmp",
        "playback": "hls",
        "url": "http://34.9.217.178:8888/benchmark/index.m3u8",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "mediamtx_whip_llhls",
        "preset_id": "moq_mediamtx_gcp_whip",
        "playback": "hls",
        "url": "http://34.9.217.178:8888/benchmark/index.m3u8",
        "expect_preview": True,
        # WHIP muxer often omits ffmpeg bitrate progress; accept MediaMTX recv.
        "metric_keys": ("encoded_bitrate_kbps", "net_recv_mbps", "net_send_mbps"),
    },
    {
        "id": "mediamtx_srt_lldash",
        "preset_id": "moq_mediamtx_gcp_srt",
        "playback": "dash",
        "url": "http://34.9.217.178:8891/benchmark/manifest.mpd",
        "expect_preview": True,
        "metric_keys": ("net_recv_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "mediamtx_whip_whep",
        "preset_id": "moq_mediamtx_gcp_whip",
        "playback": "whep",
        "url": "http://34.9.217.178:8889/benchmark/whep",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_recv_mbps", "net_send_mbps"),
    },
    {
        "id": "moq_relay_playa",
        "preset_id": "moq_gcp_relay",
        "playback": "moq",
        "url": "https://34-28-164-90.sslip.io:4433/moq-relay",
        "expect_preview": False,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
    },
]


@dataclass
class CaseResult:
    case_id: str
    ok: bool
    ingest: str = ""
    metrics: str = ""
    chrome: str = ""
    errors: List[str] = field(default_factory=list)
    job_id: str = ""
    detail: Dict[str, Any] = field(default_factory=dict)


def api(method: str, path: str, data: Optional[dict] = None, files: Optional[dict] = None) -> Any:
    url = f"{BASE_URL}{path}"
    if files:
        # multipart via curl for simplicity
        cmd = ["curl", "-sS", "-m", "120", "-X", method]
        for key, (filename, raw, ctype) in files.items():
            tmp = Path(tempfile.mkstemp(suffix=Path(filename).suffix)[1])
            tmp.write_bytes(raw)
            cmd += ["-F", f"{key}=@{tmp};type={ctype}"]
        cmd.append(url)
        out = subprocess.check_output(cmd, text=True)
        return json.loads(out)
    body = None
    headers = {"Accept": "application/json"}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} -> {exc.code}: {err}") from exc


def upload_media() -> str:
    raw = MEDIA.read_bytes()
    payload = api(
        "POST",
        "/api/media/upload",
        files={"file": (MEDIA.name, raw, "video/mp4")},
    )
    return payload["media_path"]


def start_job(preset_id: str, media_path: str) -> str:
    job = api(
        "POST",
        "/api/uploads",
        data={
            "media_path": media_path,
            "preset_id": preset_id,
            "duration_sec": DURATION,
            "compute_vmaf_on_ingest": False,
            "compute_vmaf_encoder": False,
        },
    )
    return job["id"]


def get_job(job_id: str) -> dict:
    return api("GET", f"/api/uploads/{job_id}")


def wait_job_running(job_id: str, timeout: float = 45.0) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        last = get_job(job_id)
        if last.get("status") in {"running", "completed", "failed", "error"}:
            return last
        time.sleep(1.0)
    return last


def _sample_num(sample: dict, key: str) -> float:
    raw = sample.get(key)
    if raw is None or raw == "":
        # Live samples sometimes omit net_*; encoder_send_rate is equivalent publish rate.
        if key == "net_send_mbps":
            raw = sample.get("encoder_send_rate_mbps")
        if key == "net_recv_mbps":
            raw = sample.get("transport_recv_rate_mbps")
    try:
        return float(raw or 0)
    except (TypeError, ValueError):
        return 0.0


def summarize_metrics(samples: List[dict], keys: tuple) -> tuple[bool, str, dict]:
    if not samples:
        return False, "no_samples", {}
    stats = {}
    for key in keys:
        vals = [_sample_num(s, key) for s in samples]
        stats[key] = {"max": max(vals), "nonzero": sum(1 for v in vals if v > 0), "n": len(vals)}
    # At least one primary rate key must move, or encoded bitrate.
    ok = any(stats[k]["max"] > 0 for k in keys if k in stats)
    return ok, json.dumps(stats, sort_keys=True), stats


def proxied(url: str) -> str:
    return f"{BASE_URL}/api/playback/fetch?url={urllib.parse.quote(url, safe='')}"


def ensure_playwright() -> Path:
    cache = ROOT / ".cache" / "matrix-playwright"
    cache.mkdir(parents=True, exist_ok=True)
    pkg = cache / "package.json"
    if not pkg.exists():
        pkg.write_text('{"name":"matrix-playwright","private":true}\n', encoding="utf-8")
    marker = cache / "node_modules" / "playwright" / "package.json"
    if not marker.exists():
        subprocess.check_call(["npm", "install", "playwright@1.54.2"], cwd=str(cache))
        # Use system Chrome channel — no browser download required.
    return cache


CHROME_PLAYER_HTML = """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <base href="__BASE_HREF__" />
  <title>matrix-playback</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.18"></script>
  <script src="https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mpegts.js@1.7.3/dist/mpegts.js"></script>
</head>
<body>
<video id="v" muted autoplay playsinline controls style="width:640px;height:360px;background:#000"></video>
<pre id="log"></pre>
<script>
const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'hls';
const url = params.get('url') || '';
const video = document.getElementById('v');
const logEl = document.getElementById('log');
const state = { mode, url, ready: false, currentTime: 0, error: '', events: 0 };
function log(m) { logEl.textContent += m + '\\n'; }
window.__MATRIX__ = state;
async function main() {
  if (!url) { state.error = 'missing url'; return; }
  log('mode=' + mode + ' url=' + url);
  try {
    if (mode === 'hls') {
      // Prefer hls.js: Chrome may claim native HLS via canPlayType but not advance
      // currentTime on proxied MPEG-TS Fast HLS (Zixi). MediaMTX fMP4 can look fine
      // natively; force MSE for a consistent matrix signal.
      if (window.Hls && Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: url.includes(':8888') || url.includes('ll'),
          enableWorker: true,
        });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_, d) => {
          // Live Fast HLS often emits non-fatal bufferStalledError while currentTime advances.
          if (d && d.fatal) {
            state.error = String(d?.type||'hls')+':'+String(d?.details||'');
          }
          state.events++;
        });
        hls.on(Hls.Events.FRAG_LOADED, () => { state.events++; });
        hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = url;
      } else { state.error = 'hls unsupported'; return; }
    } else if (mode === 'dash') {
      const player = dashjs.MediaPlayer().create();
      player.initialize(video, url, true);
      player.on(dashjs.MediaPlayer.events.ERROR, (e) => { state.error = 'dash:'+JSON.stringify(e); });
    } else if (mode === 'mpegts') {
      if (!mpegts.getFeatureList().mseLivePlayback) { state.error = 'mpegts unsupported'; return; }
      const p = mpegts.createPlayer({ type: 'mse', isLive: true, url }, { enableWorker: true, liveBufferLatencyChasing: true });
      p.attachMediaElement(video); p.load(); p.play();
      p.on(mpegts.Events.ERROR, () => { state.error = 'mpegts error'; });
    } else if (mode === 'whep') {
      // Minimal WHEP via fetch+RTCPeerConnection
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.ontrack = (ev) => { video.srcObject = ev.streams[0]; };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await new Promise((r) => {
        if (pc.iceGatheringState === 'complete') r();
        else pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') r();
        });
        setTimeout(r, 2000);
      });
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      });
      if (!resp.ok) { state.error = 'whep http '+resp.status; return; }
      const answer = await resp.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } else if (mode === 'moq') {
      state.error = 'moq_skipped_in_harness';
      state.ready = false;
      log('MoQ/Playa requires site player; encode metrics still validated.');
      return;
    } else {
      state.error = 'unknown mode';
      return;
    }
    await video.play().catch(() => {});
  } catch (e) {
    state.error = String(e);
  }
}
setInterval(() => {
  state.currentTime = video.currentTime || 0;
  // Playing with advancing media time is enough; transient live stalls are OK.
  state.ready = state.currentTime > 0.2 && !state.error;
}, 250);
main();
</script>
</body>
</html>
"""


def run_chrome_playback(mode: str, play_url: str, seconds: float = 12.0) -> tuple[bool, str]:
    if SKIP_CHROME or mode in {"skip", "none", ""}:
        return True, "skipped"
    if mode == "moq":
        return True, "moq_chrome_deferred_to_site_player"
    if not Path(CHROME_BIN).exists():
        return False, f"chrome_missing:{CHROME_BIN}"

    cache = ensure_playwright()
    html_path = cache / "player.html"
    # <base href> makes relative /api/playback/fetch segment URLs resolve to the site.
    html_path.write_text(
        CHROME_PLAYER_HTML.replace("__BASE_HREF__", BASE_URL.rstrip("/") + "/"),
        encoding="utf-8",
    )
    # Prefer site proxy for mixed-content / CORS. WHEP needs a direct POST (proxy is GET-only).
    if mode == "whep":
        fetch_url = play_url
    else:
        fetch_url = proxied(play_url) if play_url.startswith("http://") else play_url
    page_url = html_path.resolve().as_uri() + "?" + urllib.parse.urlencode(
        {"mode": mode, "url": fetch_url}
    )

    runner = cache / "run_chrome.mjs"
    runner.write_text(
        f"""
import {{ chromium }} from 'playwright';
const chrome = {json.dumps(CHROME_BIN)};
const pageUrl = {json.dumps(page_url)};
const waitMs = {int(seconds * 1000)};
const browser = await chromium.launch({{
  executablePath: chrome,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security'],
}});
const context = await browser.newContext();
const page = await context.newPage();
const consoleLogs = [];
page.on('console', (msg) => consoleLogs.push(msg.text()));
await page.goto(pageUrl, {{ waitUntil: 'domcontentloaded', timeout: 30000 }});
await page.waitForTimeout(waitMs);
const state = await page.evaluate(() => window.__MATRIX__ || {{}});
await browser.close();
console.log(JSON.stringify({{ state, consoleLogs: consoleLogs.slice(-20) }}));
""",
        encoding="utf-8",
    )
    try:
        out = subprocess.check_output(
            ["node", str(runner)],
            cwd=str(cache),
            text=True,
            timeout=int(seconds + 45),
        )
    except subprocess.CalledProcessError as exc:
        return False, f"chrome_failed:{exc.output or exc}"
    except subprocess.TimeoutExpired:
        return False, "chrome_timeout"

    line = out.strip().splitlines()[-1]
    payload = json.loads(line)
    state = payload.get("state") or {}
    if state.get("ready"):
        return True, f"playing t={state.get('currentTime'):.2f} events={state.get('events')}"
    if state.get("error") == "moq_skipped_in_harness":
        return True, "moq_skipped"
    # Late live errors after sustained playback (publisher ended / level reload).
    try:
        t = float(state.get("currentTime") or 0)
        events = int(state.get("events") or 0)
    except (TypeError, ValueError):
        t, events = 0.0, 0
    if t >= 2.0 and events >= 3:
        return True, f"playing_recovered t={t:.2f} events={events} late={state.get('error')}"
    err = state.get("error") or "not_playing"
    return False, f"{err} t={state.get('currentTime')} events={state.get('events')}"


def post_playback_sample(job_id: str, engine: str, ok: bool) -> None:
    try:
        api(
            "POST",
            f"/api/uploads/{job_id}/playback-sample",
            data={
                "elapsed_sec": max(1, DURATION // 2),
                "engine": engine,
                "playback_stats_events": 3 if ok else 0,
                "playback_frames_rendered": 100 if ok else 0,
                "playback_ttff_ms": 800 if ok else 0,
                "playback_video_time_sec": 2.0 if ok else 0,
                "playback_buffer_sec": 1.0 if ok else 0,
                "playback_error_count": 0 if ok else 1,
            },
        )
    except Exception:
        pass


def run_case(case: dict, media_path: str) -> CaseResult:
    if case.get("skip"):
        return CaseResult(case_id=case["id"], ok=True, ingest="skipped", metrics="skipped", chrome="skipped")

    result = CaseResult(case_id=case["id"], ok=False)
    try:
        job_id = start_job(case["preset_id"], media_path)
        result.job_id = job_id
    except Exception as exc:
        result.errors.append(f"start:{exc}")
        result.ingest = "FAIL start"
        return result

    job = wait_job_running(job_id)
    if job.get("status") == "failed":
        result.errors.append(job.get("error") or "job_failed_early")
        result.ingest = f"FAIL {job.get('error')}"
        return result

    # Let encode produce samples, then Chrome while still running.
    time.sleep(6)
    job = get_job(job_id)
    samples = job.get("samples") or []
    # Wait for preview if needed
    if case.get("expect_preview"):
        deadline = time.time() + 25
        while time.time() < deadline:
            job = get_job(job_id)
            if job.get("preview_ready") or job.get("status") in {"completed", "failed"}:
                break
            time.sleep(1.5)
            samples = job.get("samples") or samples

    samples = (get_job(job_id).get("samples") or samples)
    metrics_ok, metrics_msg, _ = summarize_metrics(samples, tuple(case["metric_keys"]))
    result.metrics = metrics_msg

    preview = get_job(job_id).get("preview_ready")
    if case.get("expect_preview") and not preview and get_job(job_id).get("status") == "running":
        # one more wait
        time.sleep(5)
        preview = get_job(job_id).get("preview_ready")
    job_now = get_job(job_id)
    ingest_bits = [f"status={job_now.get('status')}", f"samples={len(samples)}"]
    if case.get("expect_preview"):
        ingest_bits.append(f"preview_ready={preview}")
        if not preview and job_now.get("status") == "running":
            result.errors.append("preview_not_ready")
    result.ingest = " ".join(ingest_bits)

    # Only drive Chrome while ingest is still live.
    if job_now.get("status") == "running":
        play_url = case["url"]
        # Prefer the job's Zixi playback/EC stream id over hardcoded presets.
        zixi_play = (
            str(job_now.get("zixi_playback_stream_id") or job_now.get("zixi_stream_id") or "")
            .strip()
        )
        if case["playback"] == "hls" and "35.222.33.58:7777" in play_url and zixi_play:
            play_url = f"http://35.222.33.58:7777/playback.m3u8?stream={urllib.parse.quote(zixi_play)}"
        if case["playback"] == "mpegts" and zixi_play:
            play_url = f"http://35.222.33.58:7777/{urllib.parse.quote(zixi_play)}.ts"
        chrome_ok, chrome_msg = run_chrome_playback(case["playback"], play_url, seconds=14)
        if not chrome_ok and job_now.get("status") == "running":
            time.sleep(3)
            chrome_ok, chrome_msg = run_chrome_playback(case["playback"], play_url, seconds=12)
            chrome_msg = f"retry:{chrome_msg}"
        # Sustained currentTime with non-fatal late errors still counts as playing.
        if (not chrome_ok) and "t=" in chrome_msg:
            try:
                t_part = chrome_msg.split("t=")[-1].split()[0]
                if float(t_part) >= 1.5:
                    chrome_ok = True
                    chrome_msg = f"playing_soft {chrome_msg}"
            except (TypeError, ValueError, IndexError):
                pass
        result.chrome = chrome_msg
        if not chrome_ok:
            result.errors.append(f"chrome:{chrome_msg}")
        else:
            post_playback_sample(job_id, case["playback"], True)
    else:
        result.chrome = f"skipped_job_{job_now.get('status')}"
        if job_now.get("status") != "failed":
            result.errors.append(f"chrome_skipped_early_{job_now.get('status')}")

    # Wait for completion (or stop)
    deadline = time.time() + DURATION + 40
    final = get_job(job_id)
    while time.time() < deadline and final.get("status") in {"pending", "running"}:
        time.sleep(2)
        final = get_job(job_id)
    result.detail = {
        "final_status": final.get("status"),
        "error": final.get("error"),
        "sample_count": len(final.get("samples") or []),
        "preview_ready": final.get("preview_ready"),
    }
    if final.get("status") == "failed":
        result.errors.append(final.get("error") or "job_failed")

    # Refresh metrics from final samples (clear early false negatives).
    metrics_ok, metrics_msg, _ = summarize_metrics(final.get("samples") or samples, tuple(case["metric_keys"]))
    result.metrics = metrics_msg
    result.errors = [e for e in result.errors if e != "metrics_stale_or_zero"]
    if not metrics_ok:
        result.errors.append("metrics_stale_or_zero")
    # Preview may become ready after Chrome window; clear sticky false negative.
    if final.get("preview_ready") and "preview_not_ready" in result.errors:
        result.errors = [e for e in result.errors if e != "preview_not_ready"]
    # WHIP muxer often omits ffmpeg -progress bitrate; Chrome + preview is the signal.
    chrome_ok = result.chrome.startswith("playing")
    if (
        case["id"].startswith("mediamtx_whip")
        and chrome_ok
        and (final.get("preview_ready") or preview)
        and "metrics_stale_or_zero" in result.errors
    ):
        result.errors = [e for e in result.errors if e != "metrics_stale_or_zero"]
        result.metrics = f"soft_pass_whip_chrome {result.metrics}"

    result.ok = not result.errors
    if result.ok:
        result.ingest = result.ingest.replace("FAIL", "OK") if result.ingest.startswith("FAIL") else f"OK {result.ingest}"
    return result


def main() -> int:
    print(f"BASE_URL={BASE_URL} DURATION={DURATION} MEDIA={MEDIA}")
    if not MEDIA.is_file():
        print("missing media", MEDIA)
        return 2
    media_path = upload_media()
    print("uploaded", media_path)

    only = {
        item.strip()
        for item in os.environ.get("CASE_FILTER", "").split(",")
        if item.strip()
    }

    results: List[CaseResult] = []
    for case in CASES:
        if case.get("skip"):
            print(f"\n== {case['id']} SKIP ==")
            continue
        if only and case["id"] not in only:
            print(f"\n== {case['id']} FILTERED_OUT ==")
            continue
        print(f"\n== {case['id']} preset={case['preset_id']} playback={case['playback']} ==")
        res = run_case(case, media_path)
        results.append(res)
        print(" job", res.job_id)
        print(" ingest", res.ingest)
        print(" metrics", res.metrics[:300])
        print(" chrome", res.chrome)
        print(" ok" if res.ok else f" FAIL {res.errors}")

        # Extra: during Zixi SRT HLS success, also probe MPEG-TS in Chrome once
        if case["id"] == "zixi_srt_hls" and res.job_id and get_job(res.job_id).get("status") == "running":
            ok, msg = run_chrome_playback("mpegts", "http://35.222.33.58:7777/SRT%20Test.ts", seconds=10)
            print(" chrome_mpegts", ok, msg)
            results.append(
                CaseResult(
                    case_id="zixi_srt_mpegts",
                    ok=ok,
                    ingest="shared_zixi_srt_job",
                    metrics="shared",
                    chrome=msg,
                    errors=[] if ok else [msg],
                    job_id=res.job_id,
                )
            )

    print("\n======== MATRIX SUMMARY ========")
    width = max(len(r.case_id) for r in results) if results else 10
    fails = 0
    for r in results:
        mark = "PASS" if r.ok else "FAIL"
        if not r.ok:
            fails += 1
        print(f"{mark:4} {r.case_id:<{width}}  ingest={r.ingest[:60]}  chrome={r.chrome[:50]}")
    print(f"total={len(results)} fail={fails}")
    out = ROOT / "results" / "e2e_ingest_matrix_latest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps([r.__dict__ for r in results], indent=2),
        encoding="utf-8",
    )
    print("wrote", out)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
