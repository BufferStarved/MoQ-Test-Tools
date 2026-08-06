"""Preview-gate probe safety: readiness checks must never read a live stream
to EOF. Regression tests for the 2026-08-01 bug where an uncapped
``response.read()`` against Zixi's endless ``http_ts_auto_out`` output left the
RTMP preview gate closed for the whole job (player stuck on "Waiting…")."""

import io
import time
import unittest
from unittest.mock import patch

from zixi_hls_health import (
    _read_capped,
    probe_http_ts_ready,
)

TS_SYNC = 0x47


class EndlessTsResponse:
    """Mimics urllib's response for a healthy live MPEG-TS stream: data keeps
    arriving forever, so an uncapped read never reaches EOF."""

    status = 200

    def __init__(self):
        self.bytes_served = 0

    def read(self, amt=None):
        if amt is None:
            raise AssertionError(
                "uncapped read() against a live TS stream — this blocks forever in production"
            )
        chunk = bytes([TS_SYNC]) + b"\x00" * (amt - 1)
        self.bytes_served += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class HangingEmptyResponse(EndlessTsResponse):
    """Zixi returns HTTP 200 then serves nothing while the input is offline."""

    def read(self, amt=None):
        return b""


class ReadCappedTests(unittest.TestCase):
    def test_stops_at_cap_on_endless_stream(self):
        response = EndlessTsResponse()
        data = _read_capped(response, 4096)
        self.assertEqual(len(data), 4096)
        self.assertLessEqual(response.bytes_served, 4096 + 65536)

    def test_returns_early_on_eof(self):
        response = io.BytesIO(b"\x47" + b"\x00" * 500)
        data = _read_capped(response, 65536)
        self.assertEqual(len(data), 501)


class ProbeHttpTsReadyTests(unittest.TestCase):
    def test_live_stream_is_ready_and_returns_promptly(self):
        with patch("zixi_hls_health.urllib.request.urlopen", return_value=EndlessTsResponse()):
            started = time.monotonic()
            health = probe_http_ts_ready("benchmark", endpoint_url="rtmp://1.2.3.4:1935/live/benchmark")
            elapsed = time.monotonic() - started
        self.assertTrue(health.ok)
        self.assertEqual(health.http_status, 200)
        # Anything near the old behavior (blocked until connection close) fails here.
        self.assertLess(elapsed, 1.0)

    def test_offline_empty_200_is_not_ready(self):
        with patch("zixi_hls_health.urllib.request.urlopen", return_value=HangingEmptyResponse()):
            health = probe_http_ts_ready("benchmark", endpoint_url="rtmp://1.2.3.4:1935/live/benchmark")
        self.assertFalse(health.ok)
        self.assertIn("bytes=0", health.detail)


if __name__ == "__main__":
    unittest.main()
