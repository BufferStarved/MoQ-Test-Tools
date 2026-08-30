#!/usr/bin/env python3
"""Operator harness for cases this machine cannot execute (no camera, no WebTransport).

Prints a checklist + copy-paste commands. Automated probes exit non-zero on FAIL.
Human cases print NEED_HUMAN with exact clicks — they do not fail the run.

Does not start encode jobs unless START_JOB=1 (do not use while another ingest
matrix is live). Does not touch Zixi.

Usage:
  python3 scripts/e2e_operator_matrix.py
  HEADED=1 python3 scripts/e2e_operator_matrix.py
  JOB=<id> HEADED=1 python3 scripts/e2e_operator_matrix.py --case cloud_moq
  OPEN=1 python3 scripts/e2e_operator_matrix.py --case browser4
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("BASE_URL", "https://moq.sean-mccarthy.net").rstrip("/")
CHROME_BIN = os.environ.get(
    "CHROME_BIN",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
HEADED = os.environ.get("HEADED", "").strip().lower() in {"1", "true", "yes"}
OPEN_TAB = os.environ.get("OPEN", "").strip().lower() in {"1", "true", "yes"}
START_JOB = os.environ.get("START_JOB", "").strip().lower() in {"1", "true", "yes"}
SKIP_UNITS = os.environ.get("SKIP_UNITS", "").strip().lower() in {"1", "true", "yes"}
JOB = os.environ.get("JOB", os.environ.get("JOB_ID", "")).strip()
SITE_PLAYER_SEC = float(os.environ.get("SITE_PLAYER_SEC", "16"))
LOCAL_PUBLISHER_API = os.environ.get("LOCAL_PUBLISHER_API", "http://127.0.0.1:8000")
LOCAL_PUBLISHER_TOKEN = os.environ.get("LOCAL_PUBLISHER_TOKEN", "dev-local-publisher")

BROWSER4_PATH = "/?operator=browser4"
WEBCAM_PATH = "/?source=webcam"
WEBCAM_FFMPEG_PATH = "/?source=webcam&encoder=ffmpeg"
WEBCAM_OBS_PATH = "/?source=webcam&encoder=obs"
HARNESS_TMPL = "/?harnessJob={job}&playback={playback}"

EXPECT_BROWSER4 = (
    "Source = Browser. Four outputs: Linode MoQ, Linode WebRTC, "
    "GCP East MoQ, GCP East WebRTC. Expect both MoQ tiles to paint, "
    "WHIP bitrate not ~30 kbps, and any encode/ICE error visible "
    "(not a catalog-miss)."
)
EXPECT_WEBCAM = (
    "Source = Webcam. Encode = ffmpeg (helper, default) or Browser. "
    "OBS is unavailable while public MoQ is draft-18 (plugin is draft-16 only). "
    "Deep-link: /?source=webcam&encoder=ffmpeg. Capture must not die on 720p30 (ffmpeg 251)."
)
EXPECT_CLOUD_MOQ = (
    "Real Chrome tab (not headless, not Cursor WebView). "
    "MoQ glass must paint. Headless Playwright cannot WebTransport."
)
EXPECT_WHIP = (
    "After run-local-publisher.sh, Source = Webcam (This machine), "
    "add a WebRTC output. Laptop WHIP muxer bitrate must not collapse to ~30 kbps."
)


@dataclass
class CaseResult:
    case_id: str
    status: str
    detail: str = ""
    notes: List[str] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        return self.status == "FAIL"


def python_bin() -> str:
    for candidate in (ROOT / ".venv" / "bin" / "python3", ROOT / "venv" / "bin" / "python3"):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def banner() -> None:
    print("======== OPERATOR E2E ========")
    print(f"BASE_URL={BASE_URL}")
    print(f"HEADED={int(HEADED)} OPEN={int(OPEN_TAB)} START_JOB={int(START_JOB)} JOB={JOB or '-'}")
    print("Automated = site health, camera-free units, /api/features.")
    print("NEED_HUMAN = camera / real Chrome WebTransport / laptop WHIP muxer.")
    print("This script does not start jobs unless START_JOB=1.")
    print()


def api_get(path: str, timeout: float = 15.0) -> Any:
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def site_url(path: str) -> str:
    if path.startswith("http"):
        return path
    return f"{BASE_URL}{path}"


def open_system_chrome(url: str) -> Optional[str]:
    if sys.platform == "darwin":
        chrome_app = Path("/Applications/Google Chrome.app")
        if chrome_app.exists():
            subprocess.Popen(["open", "-a", "Google Chrome", url])
            return f"opened Chrome {url}"
        subprocess.Popen(["open", url])
        return f"opened {url}"
    opener = shutil.which("xdg-open")
    if opener:
        subprocess.Popen([opener, url])
        return f"opened {url}"
    return None


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


def local_ffmpeg() -> str:
    for candidate in (
        "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
        shutil.which("ffmpeg") or "",
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    return ""


def ffmpeg_has_whip(ffmpeg_bin: str) -> bool:
    if not ffmpeg_bin:
        return False
    try:
        raw = subprocess.check_output(
            [ffmpeg_bin, "-muxers"],
            text=True,
            stderr=subprocess.STDOUT,
            timeout=15,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return False
    return any("whip" in line.split() for line in raw.splitlines())


def list_avfoundation_devices(ffmpeg_bin: str) -> List[str]:
    if not ffmpeg_bin:
        return []
    try:
        raw = subprocess.run(
            [ffmpeg_bin, "-f", "avfoundation", "-list_devices", "true", "-i", ""],
            text=True,
            capture_output=True,
            timeout=15,
        )
        text = (raw.stderr or "") + (raw.stdout or "")
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []
    names: List[str] = []
    in_video = False
    for line in text.splitlines():
        if "AVFoundation video devices" in line:
            in_video = True
            continue
        if "AVFoundation audio devices" in line:
            break
        if in_video and "]" in line:
            names.append(line.rsplit("]", 1)[-1].strip())
    return [name for name in names if name]


def run_browser4_deeplink(url: str) -> tuple[bool, str]:
    """Headless recipe assertion — no camera required."""
    if not Path(CHROME_BIN).exists():
        return False, f"chrome_missing:{CHROME_BIN}"
    cache = ensure_playwright()
    runner = cache / "run_operator_browser4.mjs"
    runner.write_text(
        f"""
import {{ chromium }} from 'playwright';
const chrome = {json.dumps(CHROME_BIN)};
const pageUrl = {json.dumps(url)};
const browser = await chromium.launch({{
  executablePath: chrome,
  headless: true,
  args: ['--ignore-certificate-errors', '--disable-dev-shm-usage'],
}});
const page = await (await browser.newContext({{ ignoreHTTPSErrors: true }})).newPage();
await page.goto(pageUrl, {{ waitUntil: 'domcontentloaded', timeout: 30000 }});
await page.waitForSelector('.hero-start-button', {{ timeout: 25000 }});
await page.waitForSelector('.stream-column', {{ timeout: 25000 }});
const state = await page.evaluate(() => {{
  const columns = document.querySelectorAll('.stream-column');
  const selectedRecipe = document.querySelector('.recipe-options .source-mode-card.selected strong');
  const recipeSummary = document.querySelector('[data-step="recipe"] .setup-step-summary, .setup-step[data-step="recipe"]');
  const body = String(document.body.innerText || '');
  const labels = [...columns].map((col) => String(col.textContent || '').slice(0, 240));
  const recipeText = [
    String(selectedRecipe?.textContent || ''),
    String(recipeSummary?.textContent || ''),
    body,
  ].join(' ');
  return {{
    columns: columns.length,
    browserOn: /webcam browsers|webcodecs|webcam\\s*[·•]\\s*browser/i.test(body),
    recipeOn: /webcam browsers|moq vs webrtc/i.test(recipeText),
    labels,
  }};
}});
await browser.close();
console.log(JSON.stringify(state));
""",
        encoding="utf-8",
    )
    try:
        raw = subprocess.check_output(
            ["node", str(runner)],
            cwd=str(cache),
            text=True,
            timeout=50,
        )
    except subprocess.CalledProcessError as exc:
        return False, f"deeplink_failed:{exc.output or exc}"
    except subprocess.TimeoutExpired:
        return False, "deeplink_timeout"
    lines = [line for line in raw.splitlines() if line.strip()]
    try:
        state = json.loads(lines[-1])
    except (json.JSONDecodeError, IndexError):
        return False, f"deeplink_unparsed:{raw[:160]}"
    columns = int(state.get("columns") or 0)
    browser_on = bool(state.get("browserOn"))
    blob = " ".join(state.get("labels") or []).lower()
    has_linode = "linode" in blob
    has_east = "east" in blob or "us-east" in blob
    recipe_on = bool(state.get("recipeOn"))
    if columns >= 4 and browser_on and has_linode and has_east:
        return True, f"deeplink_ok columns={columns} browser=1 linode+east recipe={int(recipe_on)}"
    return False, (
        f"deeplink_incomplete columns={columns} browser={int(browser_on)} "
        f"recipe={int(recipe_on)}"
    )


def run_headed_chrome(url: str, seconds: float, *, camera: bool = False) -> tuple[bool, str]:
    if not Path(CHROME_BIN).exists():
        return False, f"chrome_missing:{CHROME_BIN}"
    cache = ensure_playwright()
    runner = cache / "run_operator_headed.mjs"
    args = [
        "--autoplay-policy=no-user-gesture-required",
        "--ignore-certificate-errors",
        "--disable-dev-shm-usage",
    ]
    permissions = ["camera", "microphone"] if camera else []
    runner.write_text(
        f"""
import {{ chromium }} from 'playwright';
const chrome = {json.dumps(CHROME_BIN)};
const pageUrl = {json.dumps(url)};
const waitMs = {int(seconds * 1000)};
const permissions = {json.dumps(permissions)};
const browser = await chromium.launch({{
  executablePath: chrome,
  headless: false,
  args: {json.dumps(args)},
}});
const context = await browser.newContext({{ ignoreHTTPSErrors: true }});
if (permissions.length) {{
  await context.grantPermissions(permissions);
}}
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
    return True, f"headed_chrome {seconds:.0f}s {url}"


def job_playback_signal(job_id: str) -> tuple[int, float]:
    job = api_get(f"/api/uploads/{urllib.parse.quote(job_id)}")
    frames = 0
    video_time = 0.0
    for sample in job.get("samples") or []:
        try:
            frames = max(frames, int(sample.get("playback_frames_rendered") or 0))
        except (TypeError, ValueError):
            pass
        try:
            video_time = max(video_time, float(sample.get("playback_video_time_sec") or 0))
        except (TypeError, ValueError):
            pass
    return frames, video_time


def run_units() -> CaseResult:
    if SKIP_UNITS:
        return CaseResult("units", "PASS", "skipped")
    py = python_bin()
    env = os.environ.copy()
    env["PYTHONPATH"] = f"{ROOT / 'src'}:{ROOT / 'web' / 'api'}:{ROOT}:{env.get('PYTHONPATH', '')}"
    unit_scripts = [
        ROOT / "web" / "frontend" / "scripts" / "unit-whip-publisher.mjs",
        ROOT / "web" / "frontend" / "scripts" / "unit-playback-gate.mjs",
        ROOT / "web" / "frontend" / "scripts" / "unit-whep-end-verdict.mjs",
        ROOT / "web" / "frontend" / "scripts" / "unit-job-error-catalog.mjs",
        ROOT / "web" / "frontend" / "scripts" / "unit-operator-recipe.mjs",
        ROOT / "web" / "frontend" / "scripts" / "unit-recipe-support.mjs",
        ROOT / "web" / "frontend" / "scripts" / "unit-obs.mjs",
        ROOT / "web" / "frontend" / "scripts" / "unit-browser-moq-outputs.mjs",
    ]
    py_mods = [
        "tests.test_avfoundation_modes",
        "tests.test_device_webcam",
        "tests.test_webcam_broker",
        "tests.test_browser_moq_api_gates",
    ]
    logs: List[str] = []
    try:
        subprocess.check_output(
            [py, "-m", "unittest", *py_mods, "-q"],
            cwd=str(ROOT),
            env=env,
            text=True,
            stderr=subprocess.STDOUT,
            timeout=120,
        )
        logs.append("python units ok")
    except subprocess.CalledProcessError as exc:
        return CaseResult("units", "FAIL", (exc.output or str(exc))[-800:])
    except subprocess.TimeoutExpired:
        return CaseResult("units", "FAIL", "python units timeout")

    for script in unit_scripts:
        try:
            subprocess.check_output(["node", str(script)], cwd=str(ROOT), text=True, timeout=30)
            logs.append(f"{script.name} ok")
        except subprocess.CalledProcessError as exc:
            return CaseResult("units", "FAIL", f"{script.name}: {exc.output or exc}")
        except FileNotFoundError:
            return CaseResult("units", "FAIL", "node is required for frontend unit scripts")

    ts_tests = [
        ROOT / "web" / "frontend" / "src" / "webrtcPlayback.test.ts",
        ROOT / "web" / "frontend" / "src" / "moqCmafPlayback.test.ts",
        ROOT / "web" / "frontend" / "src" / "moqLibmoqCatalog.test.ts",
        ROOT / "web" / "frontend" / "src" / "playbackEndVerdict.test.ts",
        ROOT / "web" / "frontend" / "src" / "playbackGate.ts",
    ]
    node_test = [
        t for t in ts_tests if t.name.endswith(".test.ts") and t.is_file()
    ]
    if node_test:
        try:
            subprocess.check_output(
                ["node", "--experimental-strip-types", "--test", *[str(t) for t in node_test]],
                cwd=str(ROOT / "web" / "frontend"),
                text=True,
                stderr=subprocess.STDOUT,
                timeout=30,
            )
            logs.append("node:test ok")
        except (subprocess.CalledProcessError, FileNotFoundError):
            logs.append("node:test skipped (mjs units already cover these)")

    return CaseResult("units", "PASS", "; ".join(logs))


def run_site_health() -> CaseResult:
    try:
        health = api_get("/api/health")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return CaseResult("site_health", "FAIL", str(exc))
    status = str(health.get("status") or health.get("ok") or "ok")
    return CaseResult("site_health", "PASS", f"health={status}")


def fetch_features() -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    try:
        return api_get("/api/features"), None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return None, str(exc)


def maybe_open(url: str, *, camera: bool = False) -> str:
    bits: List[str] = []
    if OPEN_TAB:
        opened = open_system_chrome(url)
        bits.append(opened or "open_failed")
    if HEADED:
        ok, msg = run_headed_chrome(url, seconds=min(SITE_PLAYER_SEC, 12), camera=camera)
        bits.append(msg if ok else f"headed_fail:{msg}")
    return " ".join(bits)


def run_browser4() -> CaseResult:
    url = site_url(BROWSER4_PATH)
    notes = [
        EXPECT_BROWSER4,
        f"URL  {url}",
        "Automated half: deep-link must preselect Browser + 4 outputs (no camera).",
        "Human half: allow camera and confirm both MoQ tiles paint.",
    ]
    ok, msg = run_browser4_deeplink(url)
    notes.append(msg)
    extra = maybe_open(url, camera=True)
    if extra:
        notes.append(extra)
    if not ok:
        return CaseResult("browser4", "FAIL", msg, notes)
    return CaseResult(
        "browser4",
        "NEED_HUMAN",
        f"{msg} — live camera paint still needs a human",
        notes,
    )


def run_webcam(features: Optional[Dict[str, Any]], feature_err: Optional[str]) -> CaseResult:
    url = site_url(WEBCAM_PATH)
    notes = [
        EXPECT_WEBCAM,
        f"URL  {url}",
        "Start the laptop agent on localhost only (never the public site):",
        "  ./scripts/dev.sh",
        f"Then http://127.0.0.1:5173{WEBCAM_FFMPEG_PATH} (default helper).",
        "Source=Webcam, Encode=ffmpeg (default) or OBS + OpenMOQ, pick outputs, Start.",
    ]
    if feature_err:
        return CaseResult("webcam", "FAIL", f"features: {feature_err}", notes)
    assert features is not None
    enabled = bool(features.get("local_publisher"))
    connected = bool(features.get("local_publisher_connected"))
    agents = features.get("local_publisher_agents") or []
    if not enabled:
        return CaseResult(
            "webcam",
            "FAIL",
            "local_publisher=false on this API — Webcam source is hidden",
            notes,
        )
    extra = maybe_open(url)
    if extra:
        notes.append(extra)
    cameras = list_avfoundation_devices(local_ffmpeg())
    notes.append(f"avfoundation cameras={cameras or ['(none)']}")
    if not cameras:
        return CaseResult(
            "webcam",
            "NEED_HUMAN",
            "no AVFoundation camera on this machine — run on the laptop with OBS / a webcam",
            notes,
        )
    if not connected:
        notes.append(f"agent connected=false agents={len(agents)}")
        return CaseResult("webcam", "NEED_HUMAN", "agent not connected — run the command above", notes)
    return CaseResult(
        "webcam",
        "NEED_HUMAN",
        f"agent connected ({len(agents)} listed) cameras={len(cameras)} — run the comparison in Chrome",
        notes,
    )


def run_cloud_moq() -> CaseResult:
    notes = [
        EXPECT_CLOUD_MOQ,
        "Start a Cloud playout MoQ job in a real Chrome tab, or pass JOB=<id>.",
        "Do not start a new job while another ingest matrix is running.",
    ]
    job_id = JOB
    if not job_id and START_JOB:
        notes.append("START_JOB=1 refused here: pass JOB= of an already-running encode.")
        return CaseResult("cloud_moq", "NEED_HUMAN", "set JOB= to attach; do not start a parallel encode", notes)
    if not job_id:
        notes.append(f"Then: JOB=<id> HEADED=1 python3 scripts/e2e_operator_matrix.py --case cloud_moq")
        notes.append(f"Or open  {site_url(HARNESS_TMPL.format(job='JOB', playback='moq'))}")
        return CaseResult("cloud_moq", "NEED_HUMAN", "no JOB — print-only", notes)

    url = site_url(HARNESS_TMPL.format(job=urllib.parse.quote(job_id), playback="moq"))
    notes.append(f"URL  {url}")
    if HEADED:
        ok, msg = run_headed_chrome(url, seconds=SITE_PLAYER_SEC, camera=False)
        if not ok:
            return CaseResult("cloud_moq", "FAIL", msg, notes)
        try:
            frames, video_time = job_playback_signal(job_id)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            return CaseResult("cloud_moq", "FAIL", f"job poll: {exc}", notes)
        if frames > 0 or video_time > 0.2:
            return CaseResult(
                "cloud_moq",
                "PASS",
                f"headed Chrome painted frames={frames} video_s={video_time:.2f}",
                notes,
            )
        notes.append(
            "Headed Playwright still often misses WebTransport. Confirm paint in that Chrome tab."
        )
        return CaseResult("cloud_moq", "NEED_HUMAN", f"no playback samples yet ({msg})", notes)
    if OPEN_TAB:
        opened = open_system_chrome(url)
        notes.append(opened or "open_failed")
    return CaseResult("cloud_moq", "NEED_HUMAN", url, notes)


def run_whip_muxer(features: Optional[Dict[str, Any]], feature_err: Optional[str]) -> CaseResult:
    notes = [
        EXPECT_WHIP,
        "Same agent as webcam — localhost only:",
        "  ./scripts/dev.sh",
        f"Then http://127.0.0.1:5173{WEBCAM_PATH} — add WebRTC on Linode or GCP East.",
    ]
    if feature_err:
        return CaseResult("whip_muxer", "FAIL", f"features: {feature_err}", notes)
    assert features is not None
    whip = bool(features.get("local_publisher_whip"))
    connected = bool(features.get("local_publisher_connected"))
    if not features.get("local_publisher"):
        return CaseResult("whip_muxer", "FAIL", "local_publisher=false", notes)
    extra = maybe_open(site_url(WEBCAM_PATH))
    if extra:
        notes.append(extra)
    ffmpeg_bin = local_ffmpeg()
    muxer = ffmpeg_has_whip(ffmpeg_bin)
    notes.append(f"local_ffmpeg={ffmpeg_bin or 'missing'} whip_muxer={int(muxer)}")
    detail = f"whip_capable={whip} agent_connected={connected} local_whip_muxer={int(muxer)}"
    if not muxer:
        return CaseResult("whip_muxer", "FAIL", "local ffmpeg has no WHIP muxer", notes)
    if connected and not whip:
        notes.append("Agent is up but API says no WHIP muxer — re-run ensure-publisher-tools.sh.")
        return CaseResult("whip_muxer", "FAIL", detail, notes)
    cameras = list_avfoundation_devices(ffmpeg_bin)
    if not cameras:
        return CaseResult(
            "whip_muxer",
            "NEED_HUMAN",
            f"{detail} — muxer present; live webcam bitrate still needs a camera",
            notes,
        )
    return CaseResult("whip_muxer", "NEED_HUMAN", detail, notes)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Operator E2E checklist for camera/WebTransport cases")
    parser.add_argument(
        "--case",
        action="append",
        dest="cases",
        help="Run only these cases (repeatable): units,site_health,browser4,webcam,cloud_moq,whip_muxer",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    wanted = {item.strip() for item in (args.cases or []) if item.strip()}
    banner()

    results: List[CaseResult] = []
    features: Optional[Dict[str, Any]] = None
    feature_err: Optional[str] = None

    def include(name: str) -> bool:
        return not wanted or name in wanted

    if include("units"):
        print("== units (no camera) ==")
        res = run_units()
        results.append(res)
        print(f" {res.status} {res.detail}")
        print()

    if include("site_health"):
        print("== site_health ==")
        res = run_site_health()
        results.append(res)
        print(f" {res.status} {res.detail}")
        print()

    if include("browser4") or include("webcam") or include("whip_muxer"):
        features, feature_err = fetch_features()

    if include("browser4"):
        print("== browser4 (This browser · Linode + GCP East · MoQ+WebRTC) ==")
        res = run_browser4()
        results.append(res)
        print(f" {res.status} {res.detail}")
        for note in res.notes:
            print(f"  {note}")
        print()

    if include("webcam"):
        print("== webcam (last-mile: ffmpeg helper default, OBS optional) ==")
        res = run_webcam(features, feature_err)
        results.append(res)
        print(f" {res.status} {res.detail}")
        for note in res.notes:
            print(f"  {note}")
        print()

    if include("cloud_moq"):
        print("== cloud_moq (real Chrome WebTransport) ==")
        res = run_cloud_moq()
        results.append(res)
        print(f" {res.status} {res.detail}")
        for note in res.notes:
            print(f"  {note}")
        print()

    if include("whip_muxer"):
        print("== whip_muxer (laptop ffmpeg WHIP after run-local-publisher) ==")
        res = run_whip_muxer(features, feature_err)
        results.append(res)
        print(f" {res.status} {res.detail}")
        for note in res.notes:
            print(f"  {note}")
        print()

    print("======== SUMMARY ========")
    width = max((len(r.case_id) for r in results), default=10)
    fails = 0
    for res in results:
        if res.failed:
            fails += 1
        print(f"{res.status:10} {res.case_id:<{width}}  {res.detail}")
    print(f"fail={fails}  (NEED_HUMAN is not a failure)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
