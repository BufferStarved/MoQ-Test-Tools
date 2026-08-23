"""Build identity for /api/health. The VM has no .git (rsync excludes it).

Two environments, one SHA scheme:

* **prod** — short commit, no suffix. Hosted at moq.sean-mccarthy.net.
* **dev** — short commit + ``-dev``. Local ``scripts/dev.sh`` / Vite.

There is no ``-dirty``. A dirty working tree is the dev environment, or it
is not what prod deployed (prod ships ``git archive HEAD``).
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


def read_moq_env() -> str:
    raw = (os.environ.get("MOQ_ENV") or "").strip().lower()
    if raw in ("prod", "dev"):
        return raw
    return "dev" if raw else "prod"


def _with_env_suffix(sha: str, env: str) -> str:
    if env == "dev" and sha and not sha.endswith("-dev"):
        return f"{sha}-dev"
    return sha


def read_build_sha(root: Path) -> str | None:
    env = read_moq_env()
    stamped = root / ".build-sha"
    try:
        text = stamped.read_text(encoding="utf-8").strip()
    except OSError:
        text = ""
    if text:
        return _with_env_suffix(text, env)
    try:
        sha = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=root,
            text=True,
            timeout=2,
        ).strip() or None
    except (OSError, subprocess.SubprocessError):
        return None
    if sha is None:
        return None
    return _with_env_suffix(sha, env)
