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


def check_ffmpeg() -> DepStatus:
    env = (os.environ.get("FFMPEG") or "").strip()
    candidates = [
        env,
        "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
        "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
        _which("ffmpeg") or "",
    ]
    for path in candidates:
        if path and Path(path).is_file() and os.access(path, os.X_OK):
            try:
                completed = subprocess.run(
                    [path, "-hide_banner", "-encoders"],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                out = (completed.stdout or "") + (completed.stderr or "")
                if "libx264" not in out:
                    return DepStatus(
                        name="ffmpeg",
                        ok=False,
                        path=path,
                        detail="found but missing libx264",
                        install_hint="brew install ffmpeg-full   # or set FFMPEG to an x264 build",
                    )
                return DepStatus(name="ffmpeg", ok=True, path=path, detail="libx264 ok")
            except (OSError, subprocess.TimeoutExpired) as exc:
                return DepStatus(
                    name="ffmpeg",
                    ok=False,
                    path=path,
                    detail=str(exc),
                    install_hint="brew install ffmpeg-full",
                )
    return DepStatus(
        name="ffmpeg",
        ok=False,
        detail="not found on PATH",
        install_hint="brew install ffmpeg-full   # macOS; Linux: install ffmpeg with libx264",
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
    return [
        check_ffmpeg(),
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
    return all(dep.ok for dep in deps if dep.name == "ffmpeg")


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
