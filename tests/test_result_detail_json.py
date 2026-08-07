"""/api/results/{filename} must return .summary.json content as parsed JSON.

Regression: the endpoint ran every file through the CSV summarizer, so a
.summary.json request came back as garbage — each raw JSON line counted as a
"sample" (samples: 121) with all-zero averages.
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


SUMMARY_PAYLOAD = {
    "csv_path": "results/upload_test.csv",
    "protocol": "srt",
    "samples": 20,
    "averages": {"server_cpu_percent": 7.5, "fps": 30.0},
    "extra": {"comparison_id": "cmp-1"},
}

CSV_CONTENT = (
    "elapsed_sec,cpu_percent,memory_mb,fps\n"
    "0,10.0,100.0,30.0\n"
    "1,20.0,110.0,30.0\n"
)


class ResultDetailJsonTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        results = root / "results"
        results.mkdir()
        (results / "upload_test.summary.json").write_text(
            json.dumps(SUMMARY_PAYLOAD), encoding="utf-8"
        )
        (results / "upload_test.csv").write_text(CSV_CONTENT, encoding="utf-8")
        (results / "broken.summary.json").write_text("{not json", encoding="utf-8")

        patcher = mock.patch.object(main, "ROOT_DIR", root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(main.app)

    def test_summary_json_returned_as_parsed_json(self):
        response = self.client.get("/api/results/upload_test.summary.json")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["filename"], "upload_test.summary.json")
        self.assertEqual(body["samples"], 20)
        self.assertEqual(body["protocol"], "srt")
        self.assertEqual(body["averages"]["server_cpu_percent"], 7.5)
        # The CSV parser's artifacts must be gone: no raw-line "rows" stuffing.
        self.assertNotIn("rows", body)
        self.assertEqual(body["extra"], {"comparison_id": "cmp-1"})

    def test_csv_still_summarized(self):
        response = self.client.get("/api/results/upload_test.csv")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["samples"], 2)
        self.assertAlmostEqual(body["averages"]["cpu_percent"], 15.0)

    def test_invalid_json_is_a_clean_500(self):
        response = self.client.get("/api/results/broken.summary.json")
        self.assertEqual(response.status_code, 500)
        self.assertIn("could not be read", response.json()["detail"])

    def test_missing_file_404(self):
        response = self.client.get("/api/results/nope.summary.json")
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
