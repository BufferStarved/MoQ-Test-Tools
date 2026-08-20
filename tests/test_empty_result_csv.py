"""Empty / header-only result CSVs must still expose protocol from the sidecar.

Regression: read_result_summary returned {samples:0, averages:{}} with no
protocol. The Results tab then called result.protocol.toUpperCase() and
unmounted the SPA.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

from job_manager import read_result_summary  # noqa: E402


class EmptyResultCsvTests(unittest.TestCase):
    def test_header_only_csv_keeps_sidecar_protocol(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "upload_empty.csv"
            csv_path.write_text("timestamp,protocol,encoded_bitrate_kbps\n", encoding="utf-8")
            sidecar = {
                "protocol": "webrtc",
                "endpoint": "https://mediamtx.example/whip/test",
                "averages": {},
                "extra": {
                    "comparison_id": "cmp-16",
                    "stream_index": 3,
                    "stream_label": "Stream 4 (WebRTC)",
                },
            }
            csv_path.with_suffix(".summary.json").write_text(
                json.dumps(sidecar), encoding="utf-8"
            )
            summary = read_result_summary(str(csv_path))
            self.assertEqual(summary["samples"], 0)
            self.assertEqual(summary["protocol"], "webrtc")
            self.assertEqual(summary["endpoint"], "https://mediamtx.example/whip/test")
            self.assertEqual(summary["rows"], [])
            self.assertEqual(summary["summary_extra"]["comparison_id"], "cmp-16")

    def test_header_only_csv_without_sidecar_is_still_safe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "upload_empty.csv"
            csv_path.write_text("timestamp,encoded_bitrate_kbps\n", encoding="utf-8")
            summary = read_result_summary(str(csv_path))
            self.assertEqual(summary["samples"], 0)
            self.assertEqual(summary["protocol"], "")
            self.assertEqual(summary["rows"], [])
            self.assertEqual(summary["averages"], {})


if __name__ == "__main__":
    unittest.main()
