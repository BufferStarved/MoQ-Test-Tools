"""Build SHA stamping for /api/health and the frontend deploy."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))


class BuildInfoTests(unittest.TestCase):
    def test_prefers_build_sha_file(self) -> None:
        from build_info import read_build_sha

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".build-sha").write_text("abc1234\n", encoding="utf-8")
            self.assertEqual(read_build_sha(root), "abc1234")

    def test_falls_back_to_git_when_file_missing(self) -> None:
        from build_info import read_build_sha

        with tempfile.TemporaryDirectory() as tmp:
            with patch("build_info.subprocess.check_output", return_value="def5678\n"):
                self.assertEqual(read_build_sha(Path(tmp)), "def5678")

    def test_health_returns_git_sha(self) -> None:
        text = (ROOT / "web" / "api" / "main.py").read_text(encoding="utf-8")
        self.assertIn("def health():", text)
        self.assertIn('"git_sha": read_build_sha(ROOT_DIR)', text)

    def test_index_html_is_not_cached(self) -> None:
        text = (ROOT / "web" / "api" / "main.py").read_text(encoding="utf-8")
        self.assertIn('FRONTEND_DIST / "index.html"', text)
        self.assertIn('"Cache-Control": "no-store"', text)

    def test_deploy_bakes_vite_git_sha(self) -> None:
        text = (ROOT / "infra" / "web" / "scripts" / "install-web-app.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("VITE_GIT_SHA", text)
        self.assertIn(".build-sha", text)
        self.assertIn("${GIT_SHA}-dirty", text)
