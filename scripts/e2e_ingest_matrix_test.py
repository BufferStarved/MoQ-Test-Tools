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
        # Primary ``SRT Test`` Fast HLS packager wedges; EC is the live path.
        # MPEG-TS is the site fallback if Fast HLS is unrecoverable.
        "url": "http://35.222.33.58:7777/playback.m3u8?stream=SRT%20Test%20EC",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
        "fallback_playback": "mpegts",
        "skip": False,
    },
    {
        "id": "zixi_srt_mpegts",
        "preset_id": "moq_zixi_gcp",
        "playback": "mpegts",
        "url": "http://35.222.33.58:7777/SRT%20Test%20EC.ts",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps",),
        "skip": True,
        "skip_reason": "covered via dual Chrome probe (HLS then MPEG-TS) during zixi_srt_hls",
    },
    {
        "id": "zixi_rtmp_hls",
        "preset_id": "moq_zixi_gcp_rtmp",
        "playback": "hls",
        "url": "http://35.222.33.58:7777/playback.m3u8?stream=benchmark",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
        "skip": False,
    },
    {
        "id": "zixi_rtmp_mpegts",
        "preset_id": "moq_zixi_gcp_rtmp",
        "playback": "mpegts",
        "url": "http://35.222.33.58:7777/benchmark.ts",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps",),
        "skip": False,
    },
    {
        "id": "zixi_tsput_hls",
        "preset_id": "moq_zixi_gcp_hls",
        "playback": "skip",
        "url": "",
        "expect_preview": False,
        "metric_keys": ("encoded_bitrate_kbps",),
        "skip": True,
        "skip_reason": (
            "Zixi HTTP-TS PUT stops draining after ~2s (Broadcaster limitation). "
            "Recipe is hidden from the UI and fail-closed at the API — do not start."
        ),
        "known_gap": "zixi_http_ts_push_retired",
    },
    {
        "id": "zixi_tsput_dash",
        "preset_id": "moq_zixi_gcp_dash",
        "playback": "skip",
        "url": "",
        "expect_preview": False,
        "metric_keys": ("encoded_bitrate_kbps",),
        "skip": True,
        "skip_reason": (
            "Zixi HTTP-TS PUT stops draining after ~2s (Broadcaster limitation). "
            "DASH PUT recipe is retired/hidden — same fail-closed gate as HLS PUT."
        ),
        "known_gap": "zixi_http_ts_push_retired",
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
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
        # Headless Playwright cannot complete WebTransport/MoQ. A real Chrome
        # tab can play CMAF; do not treat missing site_player samples as a
        # product regression when encode/preview are healthy.
        "requires_webtransport": True,
    },
]

# GCP us-east1 four-protocol matrix (local ffmpeg → east ingest, 2026-08-18).
# STACK=east python3 scripts/e2e_ingest_matrix_test.py
EAST_ZIXI = os.environ.get("GCP_EAST_ZIXI_IP", "35.196.215.179")
EAST_WEB = os.environ.get("GCP_EAST_WEB_IP", "35.196.97.22")
EAST_RELAY = os.environ.get("GCP_EAST_RELAY_DOMAIN", "34-138-137-211.sslip.io")
EAST_CASES = [
    {
        "id": "east_mediamtx_whip_whep",
        "preset_id": "moq_mediamtx_gcp_east_whip",
        "playback": "whep",
        "url": f"http://{EAST_WEB}:8889/benchmark/whep",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_recv_mbps", "net_send_mbps"),
        "fail_if_error_contains": "exited with code 69",
    },
    {
        "id": "east_moq_relay_playa",
        "preset_id": "moq_gcp_east_relay",
        "playback": "moq",
        "url": f"https://{EAST_RELAY}:4433/moq-relay",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
        "requires_webtransport": True,
    },
    {
        "id": "east_zixi_srt_mpegts",
        "preset_id": "moq_zixi_gcp_east",
        "playback": "mpegts",
        "url": f"http://{EAST_ZIXI}:7777/SRT%20Test.ts",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
    },
    {
        "id": "east_zixi_rtmp_mpegts",
        "preset_id": "moq_zixi_gcp_east_rtmp",
        "playback": "mpegts",
        "url": f"http://{EAST_ZIXI}:7777/benchmark.ts",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
    },
    {
        "id": "east_mediamtx_srt_llhls",
        "preset_id": "moq_mediamtx_gcp_east_srt",
        "playback": "hls",
        "url": f"http://{EAST_WEB}:8888/benchmark/index.m3u8",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "net_recv_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "east_mediamtx_rtmp_llhls",
        "preset_id": "moq_mediamtx_gcp_east_rtmp",
        "playback": "hls",
        "url": f"http://{EAST_WEB}:8888/benchmark/index.m3u8",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
    },
]

LINODE_ZIXI = os.environ.get("LINODE_ZIXI_IP", "45.33.68.151")
LINODE_WEB = os.environ.get("LINODE_WEB_IP", "66.175.213.81")
LINODE_RELAY = os.environ.get("LINODE_RELAY_DOMAIN", "45-79-177-85.sslip.io")
LINODE_CASES = [
    {
        "id": "linode_zixi_srt_mpegts",
        "preset_id": "moq_zixi_linode",
        "playback": "mpegts",
        "url": f"http://{LINODE_ZIXI}:7777/SRT%20Test%20EC.ts",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
    },
    {
        "id": "linode_zixi_rtmp_mpegts",
        "preset_id": "moq_zixi_linode_rtmp",
        "playback": "mpegts",
        "url": f"http://{LINODE_ZIXI}:7777/benchmark.ts",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
    },
    {
        "id": "linode_zixi_tsput",
        "preset_id": "moq_zixi_linode_hls",
        "playback": "skip",
        "url": "",
        "expect_preview": False,
        "metric_keys": ("encoded_bitrate_kbps",),
        "skip": True,
        "skip_reason": (
            "Zixi HTTP-TS PUT stops draining after ~2s (Broadcaster limitation). "
            "Recipe is hidden from the UI and fail-closed at the API — do not start."
        ),
        "known_gap": "zixi_http_ts_push_retired",
    },
    {
        "id": "linode_mediamtx_srt_llhls",
        "preset_id": "moq_mediamtx_linode_srt",
        "playback": "hls",
        "url": f"http://{LINODE_WEB}:8888/benchmark/index.m3u8",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "net_recv_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "linode_mediamtx_rtmp_llhls",
        "preset_id": "moq_mediamtx_linode_rtmp",
        "playback": "hls",
        "url": f"http://{LINODE_WEB}:8888/benchmark/index.m3u8",
        "expect_preview": True,
        "metric_keys": ("net_send_mbps", "encoded_bitrate_kbps"),
    },
    {
        "id": "linode_mediamtx_whip_whep",
        "preset_id": "moq_mediamtx_linode_whip",
        "playback": "whep",
        "url": f"http://{LINODE_WEB}:8889/benchmark/whep",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_recv_mbps", "net_send_mbps"),
    },
    {
        "id": "linode_moq_relay_playa",
        "preset_id": "moq_linode_relay",
        "playback": "moq",
        "url": f"https://{LINODE_RELAY}:4433/moq-relay",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps"),
        "requires_webtransport": True,
    },
]

# Keys we expect to move on a healthy encode (0 can be valid for lag/loss).
COMPLETENESS_KEYS = (
    "encoded_bitrate_kbps",
    "fps",
    "speed",
    "encoder_send_rate_mbps",
    "net_send_mbps",
    "net_recv_mbps",
    "net_rtt_ms",
    "encode_lag_ms",
    "cpu_percent",
)


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
    gated: bool = False
    gate_reason: str = ""
    skipped: bool = False


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
        # queued = waiting for a cloud encode slot; keep polling.
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


def metric_completeness(samples: List[dict]) -> dict:
    if not samples:
        return {"n": 0, "populated": [], "zero": list(COMPLETENESS_KEYS)}
    populated = []
    zero = []
    for key in COMPLETENESS_KEYS:
        vals = [_sample_num(s, key) for s in samples]
        if max(vals) > 0:
            populated.append(key)
        else:
            zero.append(key)
    return {"n": len(samples), "populated": populated, "zero": zero}


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
      const p = mpegts.createPlayer({ type: 'mse', isLive: true, url }, {
        enableWorker: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3.5,
        liveBufferLatencyMinRemain: 0.8,
        enableStashBuffer: true,
      });
      p.attachMediaElement(video); p.load(); p.play();
      p.on(mpegts.Events.ERROR, () => { state.error = 'mpegts error'; });
    } else if (mode === 'whep') {
      // Native WHEP: gather ICE, strip trickle (MediaMTX waits on PATCH otherwise),
      // POST via the site SDP proxy, retry 404 until the WHIP publisher is up.
      let last = 'whep connect failed';
      for (let attempt = 1; attempt <= 8; attempt++) {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.ontrack = (ev) => { video.srcObject = ev.streams[0] || new MediaStream([ev.track]); video.play().catch(()=>{}); };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((r) => {
          if (pc.iceGatheringState === 'complete') r();
          else pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') r();
          });
          setTimeout(r, 3500);
        });
        const sdp = (pc.localDescription && pc.localDescription.sdp || '').replace(/a=ice-options:trickle\\s*\\r?\\n/gi, '');
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp', 'Accept': 'application/sdp' },
          body: sdp,
        });
        if (resp.status === 406) {
          pc.close();
          last = 'whep http 406';
          continue;
        }
        if (!resp.ok) {
          last = 'whep http '+resp.status;
          pc.close();
          if (resp.status === 404 || resp.status === 400) {
            await new Promise((r) => setTimeout(r, 400 * attempt));
            continue;
          }
          state.error = last;
          return;
        }
        await pc.setRemoteDescription({ type: 'answer', sdp: await resp.text() });
        last = '';
        break;
      }
      if (last) { state.error = last; return; }
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
  state.videoWidth = video.videoWidth || 0;
  // Playing with advancing media time is enough; transient live stalls are OK.
  // WHEP can decode frames before currentTime moves; videoWidth is the signal.
  state.ready = (state.currentTime > 0.2 || state.videoWidth > 0) && !state.error;
}, 250);
main();
</script>
</body>
</html>
"""


def _job_has_real_playback(job_id: str) -> tuple[int, float, float]:
    samples = get_job(job_id).get("samples") or []
    frames = 0
    e2e = 0.0
    video_time = 0.0
    for sample in samples:
        try:
            frames = max(frames, int(sample.get("playback_frames_rendered") or 0))
        except (TypeError, ValueError):
            pass
        try:
            e2e = max(e2e, float(sample.get("e2e_latency_ms") or 0))
        except (TypeError, ValueError):
            pass
        try:
            video_time = max(video_time, float(sample.get("playback_video_time_sec") or 0))
        except (TypeError, ValueError):
            pass
    return frames, e2e, video_time


def run_site_player(job_id: str, mode: str, seconds: float = 14.0) -> tuple[bool, str]:
    """Drive the real site StreamPlayer so playback_* / e2e are posted by the reporter."""
    if SKIP_CHROME or mode in {"skip", "none", ""}:
        return True, "skipped"
    if not Path(CHROME_BIN).exists():
        return False, f"chrome_missing:{CHROME_BIN}"

    page_url = (
        f"{BASE_URL}/?harnessJob={urllib.parse.quote(job_id)}"
        f"&playback={urllib.parse.quote(mode)}"
    )
    cache = ensure_playwright()
    runner = cache / "run_site_player.mjs"
    runner.write_text(
        f"""
import {{ chromium }} from 'playwright';
const chrome = {json.dumps(CHROME_BIN)};
const pageUrl = {json.dumps(page_url)};
const waitMs = {int(seconds * 1000)};
const browser = await chromium.launch({{
  executablePath: chrome,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors', '--disable-dev-shm-usage'],
}});
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(pageUrl, {{ waitUntil: 'domcontentloaded', timeout: 30000 }});
await page.waitForTimeout(waitMs);
await browser.close();
console.log(JSON.stringify({{ ok: true }}));
""",
        encoding="utf-8",
    )
    try:
        subprocess.check_output(
            ["node", str(runner)],
            cwd=str(cache),
            text=True,
            timeout=int(seconds + 45),
        )
    except subprocess.CalledProcessError as exc:
        return False, f"chrome_failed:{exc.output or exc}"
    except subprocess.TimeoutExpired:
        return False, "chrome_timeout"

    frames, e2e, video_time = _job_has_real_playback(job_id)
    if frames > 0 or video_time > 0.2:
        return True, f"playing site_player frames={frames} video_s={video_time:.2f} e2e={e2e:.0f}"
    return False, "site_player_no_playback_samples"


def chrome_modes_for_case(case: dict) -> List[str]:
    modes: List[str] = []
    primary = str(case.get("playback") or "")
    if primary:
        modes.append(primary)
    fallback = str(case.get("fallback_playback") or "")
    if fallback and fallback not in modes:
        modes.append(fallback)
    return modes


def skipped_case_result(case: dict) -> CaseResult:
    reason = str(case.get("skip_reason") or "skipped")
    return CaseResult(
        case_id=case["id"],
        ok=True,
        ingest="skipped",
        metrics="skipped",
        chrome=f"skipped:{reason}",
        skipped=True,
        gated=True,
        gate_reason=reason,
        detail={"skip_reason": reason, "known_gap": case.get("known_gap")},
    )


def probe_site_player(job_id: str, modes: List[str], seconds: float) -> tuple[bool, str]:
    messages: List[str] = []
    for mode in modes:
        if mode in {"skip", "none", ""}:
            return True, "skipped"
        ok, msg = run_site_player(job_id, mode, seconds=seconds)
        messages.append(f"{mode}:{msg}")
        if ok:
            return True, " ".join(messages)
    return False, " ".join(messages) if messages else "chrome_no_modes"


def run_case(case: dict, media_path: str) -> CaseResult:
    if case.get("skip"):
        return skipped_case_result(case)

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
        needle = str(case.get("fail_if_error_contains") or "")
        if needle and needle in str(job.get("error") or ""):
            result.errors.append(f"forbidden_error:{needle}")
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

    # Drive the real site player (same StreamPlayer reporter) while ingest is live.
    chrome_modes = chrome_modes_for_case(case)
    if job_now.get("status") == "running":
        chrome_ok, chrome_msg = probe_site_player(
            job_id,
            chrome_modes,
            seconds=float(os.environ.get("SITE_PLAYER_SEC", "16")),
        )
        if not chrome_ok and get_job(job_id).get("status") == "running":
            time.sleep(3)
            retry_ok, retry_msg = probe_site_player(job_id, chrome_modes, seconds=12)
            chrome_ok = retry_ok
            chrome_msg = f"{chrome_msg} retry:{retry_msg}"
        result.chrome = chrome_msg
        if not chrome_ok:
            if case.get("requires_webtransport"):
                result.gated = True
                result.gate_reason = (
                    "requires_webtransport: headless Playwright cannot verify MoQ/WebTransport; "
                    "encode/preview remain the product signal"
                )
                result.chrome = f"gated_requires_webtransport:{chrome_msg}"
            else:
                result.errors.append(f"chrome:{chrome_msg}")
    else:
        result.chrome = f"skipped_job_{job_now.get('status')}"
        if job_now.get("status") != "failed":
            result.errors.append(f"chrome_skipped_early_{job_now.get('status')}")

    # Wait for completion (or stop)
    deadline = time.time() + DURATION + 40
    final = get_job(job_id)
    while time.time() < deadline and final.get("status") in {"pending", "queued", "running"}:
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
        needle = str(case.get("fail_if_error_contains") or "")
        if needle and needle in str(final.get("error") or ""):
            result.errors.append(f"forbidden_error:{needle}")

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
    chrome_ok = "playing site_player" in result.chrome
    result.detail["metric_completeness"] = metric_completeness(final.get("samples") or samples)
    if (
        (
            case["id"].startswith("mediamtx_whip")
            or case["id"].startswith("east_mediamtx_whip")
            or case["id"].startswith("linode_mediamtx_whip")
        )
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


def selected_cases() -> List[dict]:
    stack = os.environ.get("STACK", "central").strip().lower()
    if stack in {"east", "gcp-east", "gcp_east"}:
        return EAST_CASES
    if stack in {"linode"}:
        return LINODE_CASES
    if stack in {"all", "both"}:
        return CASES + EAST_CASES + LINODE_CASES
    return CASES


def main() -> int:
    cases = selected_cases()
    print(f"BASE_URL={BASE_URL} DURATION={DURATION} MEDIA={MEDIA} STACK={os.environ.get('STACK', 'central')} cases={len(cases)}")
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
    for case in cases:
        if only and case["id"] not in only:
            print(f"\n== {case['id']} FILTERED_OUT ==")
            continue
        if case.get("skip"):
            print(f"\n== {case['id']} SKIP ==")
            print(f" reason {case.get('skip_reason') or 'skipped'}")
            results.append(skipped_case_result(case))
            continue
        print(f"\n== {case['id']} preset={case['preset_id']} playback={case['playback']} ==")
        res = run_case(case, media_path)
        results.append(res)
        print(" job", res.job_id)
        print(" ingest", res.ingest)
        print(" metrics", res.metrics[:300])
        print(" chrome", res.chrome)
        if res.gated and res.ok:
            print(f" GATED {res.gate_reason}")
        else:
            print(" ok" if res.ok else f" FAIL {res.errors}")

    print("\n======== MATRIX SUMMARY ========")
    width = max(len(r.case_id) for r in results) if results else 10
    fails = 0
    gated = 0
    for r in results:
        if not r.ok:
            mark = "FAIL"
            fails += 1
        elif r.skipped:
            mark = "SKIP"
            gated += 1
        elif r.gated:
            mark = "GATE"
            gated += 1
        else:
            mark = "PASS"
        print(f"{mark:4} {r.case_id:<{width}}  ingest={r.ingest[:60]}  chrome={r.chrome[:50]}")
    print(f"total={len(results)} fail={fails} gated={gated}")
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
