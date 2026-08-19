"""Pick an AVFoundation capture mode the device actually supports.

OBS Virtual Camera (and some USB gadgets) advertise a single mode such as
``1920x1080@[60 60]fps``. Asking for ``-framerate 30 -video_size 1280x720``
exits ffmpeg with code 251 ("Selected framerate is not supported").
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

# ffmpeg dumps: 1920x1080@[60.000000 60.000000]fps
MODE_RE = re.compile(
    r"(?P<w>\d+)x(?P<h>\d+)@\[(?P<fmin>[\d.]+)\s+(?P<fmax>[\d.]+)\]fps"
)

PREFERRED_SIZE = "1280x720"
PREFERRED_FPS = 30.0
VIRTUAL_CAM_FALLBACK_SIZE = "1920x1080"
VIRTUAL_CAM_FALLBACK_FPS = 60.0


@dataclass(frozen=True)
class AvfoundationMode:
    width: int
    height: int
    fps_min: float
    fps_max: float

    @property
    def size(self) -> str:
        return f"{self.width}x{self.height}"

    @property
    def native_fps(self) -> float:
        return self.fps_max

    def supports_fps(self, fps: float, *, tol: float = 0.05) -> bool:
        return self.fps_min - tol <= fps <= self.fps_max + tol


def parse_avfoundation_supported_modes(stderr: str) -> List[AvfoundationMode]:
    """Parse ``Supported modes:`` lines from an avfoundation open failure."""
    modes: List[AvfoundationMode] = []
    seen: set[Tuple[int, int, float, float]] = set()
    for match in MODE_RE.finditer(stderr or ""):
        width = int(match.group("w"))
        height = int(match.group("h"))
        fps_min = float(match.group("fmin"))
        fps_max = float(match.group("fmax"))
        key = (width, height, fps_min, fps_max)
        if key in seen:
            continue
        seen.add(key)
        modes.append(
            AvfoundationMode(width=width, height=height, fps_min=fps_min, fps_max=fps_max)
        )
    return modes


def _parse_size(size: str) -> Tuple[int, int]:
    width_s, height_s = size.lower().split("x", 1)
    return int(width_s), int(height_s)


def pick_avfoundation_mode(
    modes: List[AvfoundationMode],
    *,
    prefer_width: int = 1280,
    prefer_height: int = 720,
    prefer_fps: float = PREFERRED_FPS,
) -> Optional[AvfoundationMode]:
    """Choose a listed mode. Never invent a size/fps the device did not advertise."""
    if not modes:
        return None

    exact = [
        mode
        for mode in modes
        if mode.width == prefer_width
        and mode.height == prefer_height
        and mode.supports_fps(prefer_fps)
    ]
    if exact:
        return exact[0]

    same_size = [
        mode for mode in modes if mode.width == prefer_width and mode.height == prefer_height
    ]
    if same_size:
        return min(same_size, key=lambda mode: abs(mode.native_fps - prefer_fps))

    landscape = [mode for mode in modes if mode.width >= mode.height]
    pool = landscape or list(modes)

    def score(mode: AvfoundationMode) -> tuple:
        # Prefer landscape, then closeness to the requested pixel count, then
        # a fps the device actually offers near prefer_fps (60 is fine).
        pixels = abs(mode.width * mode.height - prefer_width * prefer_height)
        fps_delta = abs(mode.native_fps - prefer_fps)
        portrait = 0 if mode.width >= mode.height else 1
        return (portrait, pixels, fps_delta)

    return min(pool, key=score)


def avfoundation_input_hints(
    mode: Optional[AvfoundationMode],
    *,
    negotiate: bool = False,
) -> Tuple[Optional[str], Optional[str]]:
    """Return ``(video_size, framerate)``. ``(None, None)`` omits both flags."""
    if negotiate or mode is None:
        return None, None
    fps = mode.native_fps
    fps_s = str(int(fps)) if abs(fps - round(fps)) < 0.05 else f"{fps:.3f}".rstrip("0").rstrip(".")
    return mode.size, fps_s


def is_virtual_camera_name(name: str) -> bool:
    lowered = (name or "").lower()
    return "virtual" in lowered or "obs" in lowered
