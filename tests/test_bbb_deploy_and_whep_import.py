"""BBB must survive rsync --delete and be fetchable on a fresh encode host."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALL = ROOT / "infra" / "web" / "scripts" / "install-web-app.sh"
FETCH = ROOT / "scripts" / "fetch-bbb.sh"
WHEP = ROOT / "web" / "frontend" / "src" / "players" / "WhepPlayer.tsx"


class BbbDeploySurviveTests(unittest.TestCase):
    def test_rsync_excludes_bbb_before_delete(self) -> None:
        text = INSTALL.read_text()
        exclude_at = text.index("--exclude 'bbb.mp4'")
        delete_at = text.index("rsync -az --delete")
        self.assertLess(delete_at, exclude_at)
        self.assertIn("fetch-bbb.sh", text)
        self.assertIn("bbb.mp4 is still missing after fetch", text)

    def test_fetch_script_exists_and_writes_dest(self) -> None:
        text = FETCH.read_text()
        self.assertIn("BBB_DEST", text)
        self.assertIn("wikimedia.org", text)
        self.assertIn("ffprobe", text)

    def test_whep_player_uses_native_session(self) -> None:
        text = WHEP.read_text()
        self.assertIn("startWhepSession", text)
        self.assertIn("waitForWhepMedia", text)
        self.assertNotIn("@eyevinn/webrtc-player", text)

    def test_whep_session_posts_sdp(self) -> None:
        text = (ROOT / "web" / "frontend" / "src" / "whepSession.ts").read_text()
        self.assertIn('"Content-Type": "application/sdp"', text)
        self.assertNotIn("const headers:", text)
        self.assertIn("disableTrickleIce", text)

    def test_install_does_not_point_recorder_at_dead_zixi(self) -> None:
        text = INSTALL.read_text()
        self.assertNotIn("MOQ_RECORDER_AGENT_URL=http://35.222.33.58:8090", text)
        self.assertIn("35.222.33.58", text)

    def test_vmaf_prep_does_not_block_encode_start(self) -> None:
        text = (ROOT / "web" / "api" / "job_manager.py").read_text()
        self.assertIn("vmaf-prep-", text)

    def test_ingest_agent_health_does_not_probe_recorder(self) -> None:
        text = (ROOT / "ingest_agent" / "main.py").read_text()
        self.assertNotIn("[MOQ_RECORDER_BIN, \"--probe\"]", text)
        self.assertIn("Do not subprocess --probe here", text)


if __name__ == "__main__":
    unittest.main()
