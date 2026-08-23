"""Build SHA stamping for /api/health and the frontend deploy."""

from __future__ import annotations

import os
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
            with patch.dict(os.environ, {"MOQ_ENV": "prod"}, clear=False):
                self.assertEqual(read_build_sha(root), "abc1234")

    def test_prod_never_appends_dev(self) -> None:
        from build_info import read_build_sha

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".build-sha").write_text("abc1234\n", encoding="utf-8")
            with patch.dict(os.environ, {"MOQ_ENV": "prod"}, clear=False):
                self.assertEqual(read_build_sha(root), "abc1234")

    def test_dev_labels_the_sha(self) -> None:
        from build_info import read_build_sha

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".build-sha").write_text("abc1234\n", encoding="utf-8")
            with patch.dict(os.environ, {"MOQ_ENV": "dev"}, clear=False):
                self.assertEqual(read_build_sha(root), "abc1234-dev")

    def test_dev_does_not_double_suffix(self) -> None:
        from build_info import read_build_sha

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".build-sha").write_text("abc1234-dev\n", encoding="utf-8")
            with patch.dict(os.environ, {"MOQ_ENV": "dev"}, clear=False):
                self.assertEqual(read_build_sha(root), "abc1234-dev")

    def test_falls_back_to_git_when_file_missing(self) -> None:
        from build_info import read_build_sha

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"MOQ_ENV": "prod"}, clear=False):
                with patch("build_info.subprocess.check_output", return_value="def5678\n"):
                    self.assertEqual(read_build_sha(Path(tmp)), "def5678")

    def test_health_returns_git_sha_and_env(self) -> None:
        text = (ROOT / "web" / "api" / "main.py").read_text(encoding="utf-8")
        self.assertIn("def health():", text)
        self.assertIn('"git_sha": read_build_sha(ROOT_DIR)', text)
        self.assertIn('"env": read_moq_env()', text)

    def test_index_html_is_not_cached(self) -> None:
        text = (ROOT / "web" / "api" / "main.py").read_text(encoding="utf-8")
        self.assertIn('FRONTEND_DIST / "index.html"', text)
        self.assertIn('"Cache-Control": "no-store"', text)

    def test_dirty_is_gone_from_prod_deploys(self) -> None:
        installer = (ROOT / "infra" / "web" / "scripts" / "install-web-app.sh").read_text(
            encoding="utf-8"
        )
        targeted = (ROOT / "scripts" / "deploy-web-targeted.sh").read_text(encoding="utf-8")
        self.assertNotIn("${GIT_SHA}-dirty", installer)
        self.assertNotIn("${GIT_SHA}-dirty", targeted)
        self.assertNotIn('GIT_SHA="${GIT_SHA}-dirty"', targeted)
        self.assertIn("git archive HEAD", installer)
        self.assertIn("git archive HEAD", targeted)
        self.assertIn("VITE_GIT_SHA", installer)
        self.assertIn(".build-sha", installer)
        self.assertIn("MOQ_ENV=prod", installer)

    def test_dev_scripts_stamp_dev(self) -> None:
        dev = (ROOT / "scripts" / "dev.sh").read_text(encoding="utf-8")
        api = (ROOT / "scripts" / "start-api.sh").read_text(encoding="utf-8")
        self.assertIn("MOQ_ENV=dev", dev)
        self.assertIn("MOQ_ENV=dev", api)
        self.assertIn("build-identity.sh", dev)
        self.assertNotIn("-dirty", dev)
        self.assertNotIn("-dirty", api)
