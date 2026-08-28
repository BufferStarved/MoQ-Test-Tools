"""Browser LOC recordings are Annex-B bytes even when named .mp4."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ingest_agent"))

from vmaf_service import _ffmpeg_input_args, _looks_like_annex_b  # noqa: E402


class VmafAnnexBTests(unittest.TestCase):
    def test_mp4_named_annex_b_dump_uses_h264_demuxer(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
            path = Path(handle.name)
            handle.write(b"\x00\x00\x00\x01\x67" + b"\x00" * 16)
        self.addCleanup(path.unlink)
        self.assertTrue(_looks_like_annex_b(path))
        self.assertEqual(
            _ffmpeg_input_args(str(path)),
            ["-f", "h264", "-framerate", "30", "-t", "8", "-i", str(path)],
        )

    def test_real_mp4_is_not_forced_h264(self) -> None:
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
            path = Path(handle.name)
            handle.write(b"\x00\x00\x00\x18ftypisom")
        self.addCleanup(path.unlink)
        self.assertFalse(_looks_like_annex_b(path))
        self.assertEqual(_ffmpeg_input_args(str(path)), ["-t", "8", "-i", str(path)])


if __name__ == "__main__":
    unittest.main()
