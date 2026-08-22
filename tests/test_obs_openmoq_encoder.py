"""OBS + OpenMOQ encoder is a laptop path, not Virtual Camera into ffmpeg."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))

import asyncio

from publisher_agent.obs_broker import ObsBroker
from publisher_agent.obs_probe import find_openmoq_plugin, plugin_search_paths
from publisher_agent.obs_websocket import (
    _auth_string,
    classify_obs_error,
    obs_request_sync,
)


class ObsOpenmoqEncoderTests(unittest.TestCase):
    def test_plugin_search_includes_macos_and_linux(self) -> None:
        paths = [str(path) for path in plugin_search_paths()]
        self.assertTrue(any("obs-studio/plugins" in item for item in paths))

    def test_find_plugin_none_when_missing(self) -> None:
        self.assertTrue(find_openmoq_plugin() is None or Path(find_openmoq_plugin()).exists())

    def test_obs_websocket_auth_is_stable(self) -> None:
        token = _auth_string("secret", "salt", "challenge")
        self.assertEqual(token, _auth_string("secret", "salt", "challenge"))
        self.assertNotEqual(token, _auth_string("other", "salt", "challenge"))

    def test_obs_is_encoder_option_not_source_replacement(self) -> None:
        from moq_publish import DEVICE_WEBCAM_MEDIA, is_device_webcam_source, is_obs_openmoq_source

        self.assertTrue(is_device_webcam_source(DEVICE_WEBCAM_MEDIA))
        self.assertFalse(is_obs_openmoq_source(DEVICE_WEBCAM_MEDIA))
        self.assertNotEqual(DEVICE_WEBCAM_MEDIA, "obs:openmoq")

    def test_obs_request_sync_is_safe_from_running_loop(self) -> None:
        async def _inside_loop() -> str:
            try:
                obs_request_sync("GetVersion")
            except Exception as exc:  # noqa: BLE001 — connection may be down
                return type(exc).__name__
            return "ok"

        name = asyncio.run(_inside_loop())
        self.assertNotEqual(name, "RuntimeError")

    def test_eio_is_obs_websocket_io_not_publisher_missing(self) -> None:
        message = classify_obs_error(OSError(5, "Input/output error"))
        self.assertIn("OBS WebSocket I/O", message)
        self.assertNotIn("publisher never started", message.lower())
        self.assertNotIn("moq5-fmp4-publish not found", message)

    def test_d18_canary_is_refused_before_startstream(self) -> None:
        from unittest.mock import patch

        broker = ObsBroker()
        with patch(
            "publisher_agent.obs_broker.find_openmoq_plugin",
            return_value="/tmp/obs-moq.plugin",
        ):
            with self.assertRaises(RuntimeError) as raised:
                broker._start_obs(
                    type("S", (), {"generation": "g"})(),
                    {
                        "encode_ladder": "720p",
                        "moq_endpoint": "https://34-28-164-90.sslip.io:14433/moq-relay",
                        "moq_namespace": "bench-obs",
                    },
                )
        text = str(raised.exception)
        self.assertIn("draft-16", text)
        self.assertIn(":14433", text)
        self.assertIn("Webcam + ffmpeg", text)
        self.assertNotIn("[Errno 5]", text)


if __name__ == "__main__":
    unittest.main()
