"""Publisher-agent dependency checks (Mac Homebrew + Linux PATH)."""

from __future__ import annotations

import glob
import os
import platform
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional


@dataclass
class DepStatus:
    name: str
    ok: bool
    path: str = ""
    detail: str = ""
    install_hint: str = ""


def _which(name: str) -> Optional[str]:
    return shutil.which(name)


def _ffmpeg_candidates() -> List[str]:
    env = (os.environ.get("FFMPEG") or "").strip()
    seen: List[str] = []
    for path in (
        env,
        "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
        "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
        _which("ffmpeg") or "",
    ):
        if path and path not in seen:
            seen.append(path)
    return seen


def _ffmpeg_feature_probe(path: str) -> tuple[bool, bool, bool, str]:
    """Return (x264, opus, whip, error)."""
    try:
        enc = subprocess.run(
            [path, "-hide_banner", "-encoders"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        enc_out = (enc.stdout or "") + (enc.stderr or "")
        mux = subprocess.run(
            [path, "-hide_banner", "-muxers"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        mux_out = (mux.stdout or "") + (mux.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, False, False, str(exc)
    has_x264 = "libx264" in enc_out
    has_opus = "libopus" in enc_out
    has_whip = bool(re.search(r"(?m)^\s*E\s+whip\b", mux_out))
    return has_x264, has_opus, has_whip, ""


def check_ffmpeg() -> DepStatus:
    last_error = ""
    x264_only: Optional[DepStatus] = None
    for path in _ffmpeg_candidates():
        if not (path and Path(path).is_file() and os.access(path, os.X_OK)):
            continue
        has_x264, has_opus, has_whip, err = _ffmpeg_feature_probe(path)
        if err:
            last_error = err
            continue
        if not has_x264:
            last_error = f"{path} is missing libx264"
            continue
        missing = []
        if not has_opus:
            missing.append("libopus")
        if not has_whip:
            missing.append("whip muxer")
        detail = "libx264 + WHIP muxer" if not missing else (
            f"libx264 ok; missing {', '.join(missing)}"
        )
        status = DepStatus(name="ffmpeg", ok=True, path=path, detail=detail)
        if has_whip:
            return status
        if x264_only is None:
            x264_only = status
    if x264_only is not None:
        return x264_only
    if last_error:
        return DepStatus(
            name="ffmpeg",
            ok=False,
            detail=last_error,
            install_hint="brew install ffmpeg-full   # or set FFMPEG to an x264 build",
        )
    return DepStatus(
        name="ffmpeg",
        ok=False,
        detail="not found on PATH",
        install_hint="brew install ffmpeg-full   # macOS; Linux: install ffmpeg with libx264",
    )


def check_ffmpeg_whip(ffmpeg: DepStatus) -> DepStatus:
    hint = (
        "brew upgrade ffmpeg && ffmpeg -hide_banner -muxers | grep whip; "
        "if empty: brew install ffmpeg-full. Restart the publisher agent."
    )
    if not ffmpeg.ok or not ffmpeg.path:
        return DepStatus(
            name="ffmpeg-whip",
            ok=False,
            detail="ffmpeg with libx264 is required first",
            install_hint=hint,
        )
    _x264, _opus, has_whip, err = _ffmpeg_feature_probe(ffmpeg.path)
    if err:
        return DepStatus(name="ffmpeg-whip", ok=False, path=ffmpeg.path, detail=err, install_hint=hint)
    if has_whip:
        return DepStatus(
            name="ffmpeg-whip",
            ok=True,
            path=ffmpeg.path,
            detail="`-f whip` muxer present",
        )
    return DepStatus(
        name="ffmpeg-whip",
        ok=False,
        path=ffmpeg.path,
        detail="this ffmpeg cannot publish WebRTC/WHIP (`Requested output format 'whip' is not known`)",
        install_hint=hint,
    )


def check_srt_live_transmit() -> DepStatus:
    path = _which("srt-live-transmit") or ""
    if path:
        return DepStatus(name="srt-live-transmit", ok=True, path=path)
    # Common Homebrew locations even if not on PATH yet.
    for candidate in (
        "/opt/homebrew/bin/srt-live-transmit",
        "/usr/local/bin/srt-live-transmit",
    ):
        if Path(candidate).is_file():
            return DepStatus(
                name="srt-live-transmit",
                ok=True,
                path=candidate,
                detail="found but not on PATH — agent will prepend its directory",
            )
    return DepStatus(
        name="srt-live-transmit",
        ok=False,
        detail="optional for SRT metrics; ffmpeg-native SRT still works",
        install_hint="brew install srt",
    )


def check_moq_publisher(repo_root: Path) -> DepStatus:
    env = (os.environ.get("OPENMOQ_PUBLISHER_BIN") or "").strip()
    candidates = [
        env,
        str(repo_root / "tools/openmoq-publisher/bin/openmoq-publisher"),
        str(repo_root / "tools/moq5-publisher/bin/moq5-fmp4-publish"),
        _which("openmoq-publisher") or "",
        _which("moq5-fmp4-publish") or "",
    ]
    for path in candidates:
        if path and Path(path).is_file() and os.access(path, os.X_OK):
            return DepStatus(name="moq-publisher", ok=True, path=path)
    return DepStatus(
        name="moq-publisher",
        ok=False,
        detail="required only for MoQ publish legs",
        install_hint="./scripts/install-openmoq-publisher.sh",
    )


def check_all(repo_root: Path) -> List[DepStatus]:
    ffmpeg = check_ffmpeg()
    return [
        ffmpeg,
        check_ffmpeg_whip(ffmpeg),
        check_srt_live_transmit(),
        check_moq_publisher(repo_root),
    ]


def ensure_tool_path(deps: List[DepStatus]) -> None:
    """Prepend discovered tool directories so child ffmpeg/srt/moq processes inherit them."""
    prefixes: List[str] = []
    for dep in deps:
        if not dep.ok or not dep.path:
            continue
        directory = str(Path(dep.path).resolve().parent)
        if directory not in prefixes:
            prefixes.append(directory)
        if dep.name == "ffmpeg":
            os.environ["FFMPEG"] = dep.path
    if prefixes:
        os.environ["PATH"] = os.pathsep.join(prefixes + [os.environ.get("PATH", "")])


def required_ok(deps: List[DepStatus]) -> bool:
    needed = {"ffmpeg", "ffmpeg-whip"}
    return all(dep.ok for dep in deps if dep.name in needed)


def list_webcam_devices(ffmpeg_path: str = "") -> List[Dict[str, object]]:
    """Cameras this machine can capture, as ``[{"index": int, "name": str}]``.

    Advertised in the agent hello so the browser can show a real device picker
    instead of relying on env-var overrides. Enumeration only lists device
    names — it does not open the camera, so no permission prompt fires here.
    """
    system = platform.system().lower()
    if system == "darwin":
        return _list_avfoundation_video_devices(ffmpeg_path)
    if system == "linux":
        return _list_v4l2_devices()
    return []


def _list_avfoundation_video_devices(ffmpeg_path: str) -> List[Dict[str, object]]:
    path = ffmpeg_path or _which("ffmpeg") or ""
    if not path:
        return []
    try:
        # Exits non-zero by design (no real input) — the device list is on stderr.
        completed = subprocess.run(
            [path, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []

    devices: List[Dict[str, object]] = []
    in_video_section = False
    for line in (completed.stderr or "").splitlines():
        if "AVFoundation video devices" in line:
            in_video_section = True
            continue
        if "AVFoundation audio devices" in line:
            break
        if not in_video_section:
            continue
        match = re.search(r"\[(\d+)\]\s+(.+?)\s*$", line)
        if not match:
            continue
        name = match.group(2)
        if name.lower().startswith("capture screen"):
            continue  # screen-capture pseudo-devices are not webcams
        devices.append({"index": int(match.group(1)), "name": name})
    return devices


def _list_v4l2_devices() -> List[Dict[str, object]]:
    devices: List[Dict[str, object]] = []
    for dev in sorted(glob.glob("/dev/video*")):
        match = re.match(r"^/dev/video(\d+)$", dev)
        if not match:
            continue
        index = int(match.group(1))
        name = dev
        sys_name = Path(f"/sys/class/video4linux/video{index}/name")
        try:
            if sys_name.is_file():
                name = sys_name.read_text().strip() or dev
        except OSError:
            pass
        devices.append({"index": index, "name": name})
    return devices
