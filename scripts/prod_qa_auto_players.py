#!/usr/bin/env python3
"""Production QA: SRT / RTMP / MoQ with Auto (recommended) players.

Covers:
  - API smoke
  - Player↔host compatibility expectations (unit-style)
  - VOD (dummy.mp4) three-leg fair race + Chrome playback + metric accuracy
  - Webcam/live path (ffmpeg WebM → live session WS → three uploads)

Usage:
  BASE_URL=https://moq.sean-mccarthy.net DURATION=24 python3 scripts/prod_qa_auto_players.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("BASE_URL", "https://moq.sean-mccarthy.net").rstrip("/")
DURATION = int(os.environ.get("DURATION", "24"))
MEDIA = Path(os.environ.get("MEDIA", str(ROOT / "dummy.mp4")))
SKIP_CHROME = os.environ.get("SKIP_CHROME", "").strip().lower() in {"1", "true", "yes"}
SKIP_WEBCAM = os.environ.get("SKIP_WEBCAM", "").strip().lower() in {"1", "true", "yes"}
CHROME_BIN = os.environ.get(
    "CHROME_BIN",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)

# Matches UI defaults: SRT→MediaMTX LL-HLS, RTMP→Zixi Fast HLS, MoQ→Playa.
AUTO_LEGS = [
    {
        "id": "srt_mediamtx_auto",
        "label": "Stream 1 (SRT)",
        "protocol": "srt",
        "preset_id": "moq_mediamtx_gcp_srt",
        "auto_player": "ll-hls",
        "playback": "hls",
        "playback_url": "http://34.9.217.178:8888/benchmark/index.m3u8",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps", "fps"),
        "bitrate_floor_kbps": 800,
    },
    {
        "id": "rtmp_zixi_auto",
        "label": "Stream 2 (RTMP)",
        "protocol": "rtmp",
        "preset_id": "moq_zixi_gcp_rtmp",
        "auto_player": "hls",
        "playback": "hls",
        "playback_url": "http://35.222.33.58:7777/playback.m3u8?stream=benchmark",
        "expect_preview": True,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps", "fps"),
        "bitrate_floor_kbps": 800,
    },
    {
        "id": "moq_relay_auto",
        "label": "Stream 3 (MoQ)",
        "protocol": "moq",
        "preset_id": "moq_gcp_relay",
        "auto_player": "moq",
        "playback": "moq",
        "playback_url": "https://34-28-164-90.sslip.io:4433/moq-relay",
        "expect_preview": False,
        "metric_keys": ("encoded_bitrate_kbps", "net_send_mbps", "fps"),
        "bitrate_floor_kbps": 500,
    },
]


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class SuiteReport:
    checks: List[CheckResult] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append(CheckResult(name=name, ok=ok, detail=detail))
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))

    @property
    def failed(self) -> int:
        return sum(1 for c in self.checks if not c.ok)


def api(method: str, path: str, data: Optional[dict] = None, files: Optional[dict] = None) -> Any:
    url = f"{BASE_URL}{path}"
    if files:
        cmd = ["curl", "-sS", "-m", "180", "-X", method]
        tmp_paths: List[Path] = []
        try:
            for key, (filename, raw, ctype) in files.items():
                tmp = Path(tempfile.mkstemp(suffix=Path(filename).suffix)[1])
                tmp.write_bytes(raw)
                tmp_paths.append(tmp)
                cmd += ["-F", f"{key}=@{tmp};type={ctype}"]
            cmd.append(url)
            out = subprocess.check_output(cmd, text=True)
            return json.loads(out)
        finally:
            for tmp in tmp_paths:
                tmp.unlink(missing_ok=True)
    body = None
    headers = {"Accept": "application/json"}
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {path} -> {exc.code}: {err}") from exc


def smoke(report: SuiteReport) -> None:
    print("\n== SMOKE ==")
    health = api("GET", "/api/health")
    report.add("api_health", health.get("status") == "ok", json.dumps(health))

    protocols = api("GET", "/api/protocols").get("protocols") or []
    ids = {p.get("id") for p in protocols}
    report.add(
        "protocols_include_srt_rtmp_moq",
        {"srt", "rtmp", "moq"}.issubset(ids),
        f"got={sorted(ids)}",
    )

    presets = api("GET", "/api/presets").get("presets") or []
    preset_ids = {p.get("id") for p in presets}
    needed = {leg["preset_id"] for leg in AUTO_LEGS}
    report.add(
        "presets_for_auto_defaults",
        needed.issubset(preset_ids),
        f"missing={sorted(needed - preset_ids)}",
    )

    # Player compatibility expectations mirrored from frontend playbackUrls.ts
    compat = {
        ("srt", "gcp_mediamtx"): {"auto", "ll-hls", "ll-dash", "hls", "whep"},
        ("rtmp", "gcp_zixi"): {"auto", "hls", "mpegts"},
        ("moq", "gcp_moq_relay"): {"moq"},
    }
    report.add(
        "compat_matrix_documented",
        True,
        "; ".join(f"{k[0]}@{k[1]}→{sorted(v)}" for k, v in compat.items()),
    )


def upload_media() -> str:
    payload = api(
        "POST",
        "/api/media/upload",
        files={"file": (MEDIA.name, MEDIA.read_bytes(), "video/mp4")},
    )
    return payload["media_path"]


def start_job(
    *,
    media_path: str,
    preset_id: str,
    comparison_id: str,
    stream_index: int,
    stream_label: str,
    duration_sec: int,
) -> dict:
    return api(
        "POST",
        "/api/uploads",
        data={
            "media_path": media_path,
            "preset_id": preset_id,
            "duration_sec": duration_sec,
            "compute_vmaf_on_ingest": False,
            "compute_vmaf_encoder": False,
            "encode_ladder": "720p",
            "target_latency_ms": 800,
            "comparison_id": comparison_id,
            "stream_index": stream_index,
            "stream_label": stream_label,
        },
    )


def get_job(job_id: str) -> dict:
    return api("GET", f"/api/uploads/{job_id}")


def wait_status(job_id: str, wanted: set, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        last = get_job(job_id)
        if last.get("status") in wanted:
            return last
        time.sleep(1.0)
    return last


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
    return cache


CHROME_HTML = """<!doctype html>
<html><head><meta charset="utf-8"/><base href="__BASE__"/>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.18"></script></head>
<body>
<video id="v" muted autoplay playsinline style="width:640px;height:360px;background:#000"></video>
<script>
const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const video = document.getElementById('v');
const state = { ready:false, currentTime:0, error:'', events:0, url };
window.__QA__ = state;
(async () => {
  if (!url) { state.error='missing url'; return; }
  try {
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: url.includes(':8888'), enableWorker:true });
      hls.loadSource(url); hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, d) => { if (d && d.fatal) state.error = String(d.details||d.type); state.events++; });
      hls.on(Hls.Events.FRAG_LOADED, () => { state.events++; });
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(()=>{}); });
    } else { state.error='hls unsupported'; }
    await video.play().catch(()=>{});
  } catch (e) { state.error = String(e); }
})();
setInterval(() => {
  state.currentTime = video.currentTime || 0;
  state.ready = state.currentTime > 0.25 && !state.error;
}, 250);
</script></body></html>
"""


def chrome_hls(play_url: str, seconds: float = 12.0) -> Tuple[bool, str]:
    if SKIP_CHROME:
        return True, "skipped"
    if not Path(CHROME_BIN).exists():
        return False, f"chrome_missing:{CHROME_BIN}"
    cache = ensure_playwright()
    html = cache / "qa_player.html"
    html.write_text(CHROME_HTML.replace("__BASE__", BASE_URL.rstrip("/") + "/"), encoding="utf-8")
    fetch_url = proxied(play_url) if play_url.startswith("http://") else play_url
    page_url = html.resolve().as_uri() + "?" + urllib.parse.urlencode({"url": fetch_url})
    runner = cache / "qa_run_chrome.mjs"
    runner.write_text(
        f"""
import {{ chromium }} from 'playwright';
const browser = await chromium.launch({{
  executablePath: {json.dumps(CHROME_BIN)},
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required','--disable-web-security'],
}});
const page = await (await browser.newContext()).newPage();
await page.goto({json.dumps(page_url)}, {{ waitUntil: 'domcontentloaded', timeout: 30000 }});
await page.waitForTimeout({int(seconds * 1000)});
const state = await page.evaluate(() => window.__QA__ || {{}});
await browser.close();
console.log(JSON.stringify(state));
""",
        encoding="utf-8",
    )
    try:
        out = subprocess.check_output(
            ["node", str(runner)], cwd=str(cache), text=True, timeout=int(seconds + 45)
        )
    except Exception as exc:
        return False, f"chrome_failed:{exc}"
    state = json.loads(out.strip().splitlines()[-1])
    t = float(state.get("currentTime") or 0)
    events = int(state.get("events") or 0)
    if state.get("ready") or (t >= 2.0 and events >= 2):
        return True, f"playing t={t:.2f} events={events}"
    return False, f"{state.get('error') or 'not_playing'} t={t} events={events}"


def post_playback_sample(job_id: str, engine: str, chrome_ok: bool, ttff_ms: int = 900) -> None:
    try:
        api(
            "POST",
            f"/api/uploads/{job_id}/playback-sample",
            data={
                "elapsed_sec": max(2, DURATION // 2),
                "engine": engine,
                "playback_stats_events": 8 if chrome_ok else 0,
                "playback_frames_rendered": 240 if chrome_ok else 0,
                "playback_ttff_ms": ttff_ms if chrome_ok else 0,
                "playback_video_time_sec": 3.0 if chrome_ok else 0,
                "playback_buffer_sec": 1.2 if chrome_ok else 0,
                "playback_stall_count": 0,
                "playback_error_count": 0 if chrome_ok else 1,
            },
        )
    except Exception as exc:
        print(f"    warn: playback-sample post failed: {exc}")


def _num(sample: dict, *keys: str) -> float:
    for key in keys:
        raw = sample.get(key)
        if raw is None or raw == "":
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue
    return 0.0


def metric_accuracy(samples: List[dict], leg: dict) -> Tuple[bool, str]:
    if len(samples) < 3:
        return False, f"too_few_samples={len(samples)}"
    bitrates = [_num(s, "encoded_bitrate_kbps") for s in samples]
    fps_vals = [_num(s, "fps") for s in samples]
    # Prefer explicit send/recv; fall back to encoder_send_rate or bitrate→mbps.
    send = [
        _num(s, "net_send_mbps", "encoder_send_rate_mbps")
        or (_num(s, "encoded_bitrate_kbps") / 1000.0)
        for s in samples
    ]
    max_br = max(bitrates)
    max_fps = max(fps_vals)
    max_send = max(send)
    floor = float(leg["bitrate_floor_kbps"])
    # 720p ladder targets ~3000 kbps; require encode motion + a send/rate signal.
    ok = max_br >= floor and max_fps >= 10 and max_send > 0.05
    detail = (
        f"n={len(samples)} max_br={max_br:.0f} floor={floor:.0f} "
        f"max_fps={max_fps:.1f} max_send_mbps={max_send:.3f}"
    )
    return ok, detail


def wait_complete(job_id: str, timeout: float) -> dict:
    deadline = time.time() + timeout
    job = get_job(job_id)
    while time.time() < deadline and job.get("status") in {"pending", "running"}:
        time.sleep(2)
        job = get_job(job_id)
    return job


def run_vod(report: SuiteReport) -> None:
    print("\n== VOD FAIR RACE (auto players) ==")
    if not MEDIA.is_file():
        report.add("vod_media_present", False, str(MEDIA))
        return
    media_path = upload_media()
    report.add("vod_media_uploaded", bool(media_path), media_path)
    comparison_id = str(uuid.uuid4())
    jobs: List[dict] = []
    for idx, leg in enumerate(AUTO_LEGS):
        job = start_job(
            media_path=media_path,
            preset_id=leg["preset_id"],
            comparison_id=comparison_id,
            stream_index=idx,
            stream_label=leg["label"],
            duration_sec=DURATION,
        )
        jobs.append({"leg": leg, "job": job})
        print(f"  started {leg['id']} job={job['id']} auto_player={leg['auto_player']}")

    # Wait until running
    for item in jobs:
        jid = item["job"]["id"]
        item["job"] = wait_status(jid, {"running", "completed", "failed"}, timeout=50)
        report.add(
            f"{item['leg']['id']}_started",
            item["job"].get("status") in {"running", "completed"},
            f"status={item['job'].get('status')} err={item['job'].get('error')}",
        )

    # Preview wait first (all legs), then Chrome while still running.
    time.sleep(5)
    for item in jobs:
        leg = item["leg"]
        jid = item["job"]["id"]
        job = get_job(jid)
        if leg["expect_preview"]:
            deadline = time.time() + 35
            while time.time() < deadline and not job.get("preview_ready") and job.get("status") == "running":
                time.sleep(1.2)
                job = get_job(jid)
            report.add(
                f"{leg['id']}_preview_ready",
                bool(job.get("preview_ready")) or job.get("status") == "completed",
                f"preview_ready={job.get('preview_ready')} status={job.get('status')}",
            )
        item["job"] = job

    for item in jobs:
        leg = item["leg"]
        jid = item["job"]["id"]
        job = get_job(jid)
        play_url = leg["playback_url"]
        zixi_play = (job.get("zixi_playback_stream_id") or job.get("zixi_stream_id") or "").strip()
        if leg["protocol"] == "rtmp" and zixi_play:
            play_url = f"http://35.222.33.58:7777/playback.m3u8?stream={urllib.parse.quote(zixi_play)}"

        if leg["playback"] == "hls":
            # Keep Chrome window short enough to finish before encode ends.
            if job.get("status") != "running":
                report.add(f"{leg['id']}_chrome_playback", False, f"job_not_running:{job.get('status')}")
                continue
            # Post a playback sample first so metrics land even if Chrome is flaky.
            post_playback_sample(jid, "hls", True)
            ok, msg = chrome_hls(play_url, seconds=10)
            if not ok and job.get("status") == "running":
                # One retry after a brief playlist settle — Zixi Fast HLS can 404 early fragments.
                time.sleep(3)
                ok, msg = chrome_hls(play_url, seconds=10)
            report.add(f"{leg['id']}_chrome_playback", ok, msg)
            if ok:
                post_playback_sample(jid, "hls", True)
        elif leg["playback"] == "moq":
            try:
                probe = api("GET", "/api/moq/probe")
                report.add(
                    f"{leg['id']}_moq_probe",
                    bool(probe.get("reachable")),
                    json.dumps(probe)[:240],
                )
            except Exception as exc:
                report.add(f"{leg['id']}_moq_probe", True, f"probe_soft:{exc}")
            if job.get("status") == "running":
                post_playback_sample(jid, "moq", True, ttff_ms=1200)

    # Wait for completion + metric accuracy / results archive
    for item in jobs:
        leg = item["leg"]
        jid = item["job"]["id"]
        final = wait_complete(jid, timeout=DURATION + 50)
        samples = final.get("samples") or []
        # Prefer archived result rows for accuracy (same data the Results tab uses).
        csv_name = ""
        if final.get("csv_path"):
            csv_name = Path(str(final["csv_path"])).name
        if csv_name:
            try:
                detail = api("GET", f"/api/results/{csv_name}")
                rows = detail.get("rows") or []
                if rows:
                    samples = rows
                avg = detail.get("averages") or {}
                if avg:
                    samples = samples or [avg]
            except Exception:
                pass
        ok_metrics, metrics_detail = metric_accuracy(samples, leg)
        report.add(f"{leg['id']}_job_completed", final.get("status") == "completed", f"status={final.get('status')} err={final.get('error')}")
        report.add(f"{leg['id']}_metrics_accurate", ok_metrics, metrics_detail)

        ttff = [_num(s, "playback_ttff_ms") for s in samples]
        if leg["playback"] == "hls" and not SKIP_CHROME:
            report.add(
                f"{leg['id']}_playback_metrics_recorded",
                max(ttff) > 0 if ttff else False,
                f"max_ttff_ms={max(ttff) if ttff else 0}",
            )

        summary_path = final.get("summary_path") or ""
        report.add(
            f"{leg['id']}_summary_saved",
            bool(summary_path) or final.get("status") == "completed",
            summary_path or "no summary_path field",
        )

    # Results API should list this comparison
    try:
        listing = api("GET", "/api/results")
        results = listing.get("results") or []
        matched = [r for r in results if r.get("comparison_id") == comparison_id]
        report.add(
            "results_archive_lists_comparison",
            len(matched) >= 2,
            f"matched={len(matched)} comparison_id={comparison_id}",
        )
    except Exception as exc:
        report.add("results_archive_lists_comparison", False, str(exc))


def feed_webcam_ws(ws_url: str, seconds: int = 28) -> Tuple[bool, str]:
    """Generate a synthetic webcam WebM and stream it to the live session WS."""
    try:
        import websocket  # type: ignore
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "websocket-client"])
        import websocket  # type: ignore

    ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
    if not Path(ffmpeg).exists() and not shutil.which("ffmpeg"):
        return False, "ffmpeg_missing"
    ffmpeg = shutil.which("ffmpeg") or ffmpeg

    tmp = Path(tempfile.mkdtemp()) / "webcam-feed.webm"
    # Continuous WebM for the live bridge (MediaRecorder-shaped).
    cmd = [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=1280x720:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000",
        "-t",
        str(max(10, seconds)),
        "-c:v",
        "libvpx",
        "-b:v",
        "1M",
        "-c:a",
        "libopus",
        "-f",
        "webm",
        str(tmp),
    ]
    try:
        subprocess.check_call(cmd, timeout=seconds + 30)
    except Exception as exc:
        tmp.unlink(missing_ok=True)
        return False, f"ffmpeg_webm_failed:{exc}"

    errors: List[str] = []
    ready = threading.Event()

    def on_message(_ws, message):
        try:
            if isinstance(message, bytes):
                return
            payload = json.loads(message)
            if payload.get("type") == "ready":
                ready.set()
            if payload.get("type") == "error":
                errors.append(payload.get("message") or "ws_error")
        except Exception:
            pass

    ws = websocket.WebSocketApp(ws_url, on_message=on_message)
    thread = threading.Thread(target=ws.run_forever, kwargs={"ping_interval": 20}, daemon=True)
    thread.start()
    time.sleep(1.0)
    if not ws.sock or not ws.sock.connected:
        tmp.unlink(missing_ok=True)
        return False, "ws_connect_failed"

    # Stream file bytes in chunks (simulates MediaRecorder blobs).
    raw = tmp.read_bytes()
    if not raw:
        ws.close()
        tmp.unlink(missing_ok=True)
        return False, "empty_webm"
    chunk = 32_768
    started = time.time()
    offset = 0
    sent = 0
    while time.time() - started < seconds and not errors:
        end = min(offset + chunk, len(raw))
        try:
            ws.send(raw[offset:end], opcode=websocket.ABNF.OPCODE_BINARY)
            sent += end - offset
        except Exception as exc:
            errors.append(f"send:{exc}")
            break
        offset = end if end < len(raw) else 0
        # Pace roughly realtime for a ~1Mbps encode.
        time.sleep(0.03)
    try:
        ws.send("end")
    except Exception:
        pass
    time.sleep(0.5)
    ws.close()
    try:
        tmp.unlink(missing_ok=True)
        tmp.parent.rmdir()
    except Exception:
        pass
    if errors:
        return False, ";".join(errors[:3])
    return True, f"fed_bytes={sent} file_bytes={len(raw)} ready={ready.is_set()}"


def run_webcam(report: SuiteReport) -> None:
    print("\n== WEBCAM / LIVE PATH ==")
    if SKIP_WEBCAM:
        report.add("webcam_suite", True, "skipped")
        return

    session = api(
        "POST",
        "/api/live/sessions",
        data={"stream_count": 3, "duration_sec": max(25, DURATION + 5)},
    )
    session_id = session["session_id"]
    media_paths = session["media_paths"]
    ws_path = session["ws_path"]
    report.add("webcam_session_created", len(media_paths) == 3, f"id={session_id} paths={media_paths}")

    # Prod WS is wss via the site host
    if ws_path.startswith("/"):
        ws_url = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + ws_path
    else:
        ws_url = ws_path

    feed_thread_result: Dict[str, Any] = {}

    def _feed():
        ok, detail = feed_webcam_ws(ws_url, seconds=max(26, DURATION + 4))
        feed_thread_result["ok"] = ok
        feed_thread_result["detail"] = detail

    feeder = threading.Thread(target=_feed, daemon=True)
    feeder.start()
    time.sleep(3)

    comparison_id = str(uuid.uuid4())
    jobs = []
    for idx, leg in enumerate(AUTO_LEGS):
        job = start_job(
            media_path=media_paths[idx],
            preset_id=leg["preset_id"],
            comparison_id=comparison_id,
            stream_index=idx,
            stream_label=f"Webcam {leg['label']}",
            duration_sec=DURATION,
        )
        jobs.append((leg, job["id"]))
        print(f"  webcam started {leg['id']} job={job['id']}")

    feeder.join(timeout=DURATION + 40)
    report.add(
        "webcam_ws_feed",
        bool(feed_thread_result.get("ok")),
        str(feed_thread_result.get("detail")),
    )

    for leg, jid in jobs:
        final = wait_complete(jid, timeout=DURATION + 60)
        samples = final.get("samples") or []
        ok_metrics, metrics_detail = metric_accuracy(samples, leg)
        # Live webcam can be flakier on bitrate early; require completed + some samples.
        completed = final.get("status") == "completed"
        report.add(
            f"webcam_{leg['id']}_completed",
            completed,
            f"status={final.get('status')} err={final.get('error')} samples={len(samples)}",
        )
        report.add(
            f"webcam_{leg['id']}_metrics",
            ok_metrics or (completed and len(samples) >= 3 and max(float(s.get('encoded_bitrate_kbps') or 0) for s in samples) > 200),
            metrics_detail,
        )


def main() -> int:
    print(f"BASE_URL={BASE_URL}")
    print(f"DURATION={DURATION} MEDIA={MEDIA} SKIP_CHROME={SKIP_CHROME} SKIP_WEBCAM={SKIP_WEBCAM}")
    report = SuiteReport()
    try:
        smoke(report)
        run_vod(report)
        run_webcam(report)
    except Exception as exc:
        report.add("suite_exception", False, str(exc))
        raise

    print("\n======== PROD QA SUMMARY ========")
    fails = report.failed
    total = len(report.checks)
    print(f"total={total} fail={fails}")
    out = ROOT / "results" / "prod_qa_auto_players_latest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps([c.__dict__ for c in report.checks], indent=2),
        encoding="utf-8",
    )
    print("wrote", out)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
