"""The Webcam helper must start from ~, not only from the repo root."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "launch-local-publisher.sh"


class LaunchLocalPublisherTests(unittest.TestCase):
    def test_finds_checkout_from_home(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            repo = home / "Developer" / "moq-test-tools"
            (repo / "scripts").mkdir(parents=True)
            stub = repo / "scripts" / "run-local-publisher.sh"
            stub.write_text("#!/bin/sh\necho FOUND:$PWD\n", encoding="utf-8")
            stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
            env = {
                **os.environ,
                "HOME": str(home),
                "PWD": str(home),
            }
            env.pop("MOQ_TEST_TOOLS", None)
            result = subprocess.run(
                ["bash", str(LAUNCHER)],
                cwd=str(home),
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("FOUND:", result.stdout)

    def test_honors_moq_test_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            home.mkdir()
            repo = Path(tmp) / "custom-root"
            (repo / "scripts").mkdir(parents=True)
            stub = repo / "scripts" / "run-local-publisher.sh"
            stub.write_text("#!/bin/sh\necho CUSTOM\n", encoding="utf-8")
            stub.chmod(stub.stat().st_mode | stat.S_IXUSR)
            result = subprocess.run(
                ["bash", str(LAUNCHER)],
                cwd=str(home),
                env={**os.environ, "HOME": str(home), "MOQ_TEST_TOOLS": str(repo)},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("CUSTOM", result.stdout)


if __name__ == "__main__":
    sys.exit(unittest.main())
