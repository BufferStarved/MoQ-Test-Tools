"""Bundled VOD assets for cloud playout (color bars, Big Buck Bunny, …)."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

DUMMY_RELATIVE = "dummy.mp4"
BBB_RELATIVE = "bbb.mp4"
# Color bars is a 60s file. BBB is ~10 min; clip bundled VOD to the same
# window so a comparison is apples-to-apples and does not sit on the
# encode host for the whole Blender short.
DEFAULT_BUNDLED_CLIP_SEC = 60
MAX_FILE_DURATION_SEC = 300

# First existing path wins. Keep names unspecialized so a downloaded
# Blender/Google copy can be dropped next to dummy.mp4.
BBB_CANDIDATES = (
    "bbb.mp4",
    "media/bbb.mp4",
    "big_buck_bunny.mp4",
    "BigBuckBunny.mp4",
    "bbb.mov",
    "media/bbb.mov",
)


def _first_existing(root: Path, relatives: Iterable[str]) -> Optional[Path]:
    for relative in relatives:
        path = (root / relative).resolve()
        try:
            if path.is_file() and path.stat().st_size > 0:
                return path
        except OSError:
            continue
    return None


def dummy_media_path(root: Path) -> Optional[Path]:
    return _first_existing(root, (DUMMY_RELATIVE,))


def bbb_media_path(root: Path) -> Optional[Path]:
    return _first_existing(root, BBB_CANDIDATES)


def clip_vod_duration_sec(
    *,
    probed_sec: int,
    requested: Optional[int],
    bundled: bool,
) -> int:
    """Bound a file encode so BBB cannot run ~10 minutes by accident."""
    probed = max(5, int(probed_sec or 0) or DEFAULT_BUNDLED_CLIP_SEC)
    if requested is not None:
        return max(5, min(MAX_FILE_DURATION_SEC, int(requested), probed))
    cap = DEFAULT_BUNDLED_CLIP_SEC if bundled else MAX_FILE_DURATION_SEC
    return max(5, min(cap, probed))


def resolve_bundled_vod(root: Path, media_path: str) -> Optional[Path]:
    """If *media_path* names a bundled VOD preset, return the file on disk."""
    name = Path(media_path.strip()).name.lower()
    if name in {"dummy.mp4", "dummy"}:
        return dummy_media_path(root)
    if name in {
        "bbb.mp4",
        "bbb",
        "bbb.mov",
        "big_buck_bunny.mp4",
        "bigbuckbunny.mp4",
    } or "big buck" in media_path.lower():
        return bbb_media_path(root)
    return None


def media_source_catalog(root: Path) -> list[dict]:
    dummy = dummy_media_path(root)
    bbb = bbb_media_path(root)
    return [
        {
            "id": "dummy",
            "label": "Default Color Bars",
            "media_path": DUMMY_RELATIVE,
            "available": dummy is not None,
            "hint": "60s color bars with time counter",
        },
        {
            "id": "bbb",
            "label": "Big Buck Bunny",
            "media_path": BBB_RELATIVE,
            "available": bbb is not None,
            "hint": (
                f"First {DEFAULT_BUNDLED_CLIP_SEC}s of Blender's short — encoded live"
                if bbb is not None
                else "Place bbb.mp4 next to dummy.mp4, or run scripts/fetch-bbb.sh"
            ),
        },
    ]
