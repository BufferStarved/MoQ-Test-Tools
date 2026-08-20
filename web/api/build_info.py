"""Build identity for /api/health. The VM has no .git (rsync excludes it)."""

from __future__ import annotations

import subprocess
from pathlib import Path


def read_build_sha(root: Path) -> str | None:
    stamped = root / ".build-sha"
    try:
        text = stamped.read_text(encoding="utf-8").strip()
    except OSError:
        text = ""
    if text:
        return text
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=root,
            text=True,
            timeout=2,
        ).strip() or None
    except (OSError, subprocess.SubprocessError):
        return None
