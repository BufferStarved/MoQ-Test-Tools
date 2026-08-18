"""Error-concealed stream create / recreate (no live Zixi required)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from zixi_error_concealment import (  # noqa: E402
    recreate_error_concealed_stream,
    zixi_error_concealed_stream_id,
)


class ErrorConcealmentIdTests(unittest.TestCase):
    def test_derived_id(self):
        self.assertEqual(zixi_error_concealed_stream_id("SRT Test"), "SRT Test EC")


class RecreateErrorConcealedStreamTests(unittest.TestCase):
    @patch("zixi_error_concealment.ensure_error_concealed_stream", return_value="SRT Test EC")
    @patch("zixi_error_concealment._call", return_value=True)
    @patch("zixi_error_concealment._stream_present", side_effect=[True, False])
    @patch("zixi_error_concealment.error_concealment_enabled", return_value=True)
    def test_removes_then_recreates(self, _enabled, present, call, ensure):
        result = recreate_error_concealed_stream(
            "SRT Test",
            base_url="http://127.0.0.1:4444",
            user="admin",
            password="secret",
        )
        self.assertEqual(result, "SRT Test EC")
        call.assert_called_once()
        self.assertIn("remove_stream.json", call.call_args[0][1])
        ensure.assert_called_once()

    @patch("zixi_error_concealment.ensure_error_concealed_stream", return_value="SRT Test EC")
    @patch("zixi_error_concealment._call")
    @patch("zixi_error_concealment._stream_present", return_value=False)
    @patch("zixi_error_concealment.error_concealment_enabled", return_value=True)
    def test_missing_stream_skips_remove(self, _enabled, _present, call, ensure):
        result = recreate_error_concealed_stream(
            "SRT Test",
            base_url="http://127.0.0.1:4444",
            user="admin",
            password="secret",
        )
        self.assertEqual(result, "SRT Test EC")
        call.assert_not_called()
        ensure.assert_called_once()

    @patch("zixi_error_concealment.error_concealment_enabled", return_value=False)
    def test_disabled_returns_none(self, _enabled):
        self.assertIsNone(recreate_error_concealed_stream("SRT Test"))


if __name__ == "__main__":
    unittest.main()
