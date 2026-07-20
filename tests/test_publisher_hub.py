"""Publisher hub agent registry + remote job dispatch."""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "web" / "api"))

from destinations import DestinationProfile  # noqa: E402
from publisher_hub import PublisherHub, local_publisher_enabled  # noqa: E402
from upload_service import UploadJob, UploadSample  # noqa: E402


def _job(job_id: str = "job-1") -> UploadJob:
    return UploadJob(
        media_path="/tmp/clip.mp4",
        destination=DestinationProfile(
            protocol="srt",
            url="srt://34.9.217.178:8890?mode=caller&streamid=publish:benchmark",
            preset_id="moq_mediamtx_gcp_srt",
            ingest_provider="gcp_mediamtx",
        ),
        duration_sec=5,
        job_id=job_id,
        publisher_host="local",
    )


class LocalPublisherFlagTests(unittest.TestCase):
    def test_enabled_truthy(self) -> None:
        for value in ("1", "true", "YES", "on"):
            with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": value}, clear=False):
                self.assertTrue(local_publisher_enabled(), msg=value)

    def test_disabled_falsy(self) -> None:
        for value in ("0", "false", "", "no"):
            with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": value}, clear=False):
                self.assertFalse(local_publisher_enabled(), msg=repr(value))


class PublisherHubTests(unittest.TestCase):
    def setUp(self) -> None:
        self.hub = PublisherHub()

    def test_status_empty(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
            status = self.hub.status()
        self.assertTrue(status["enabled"])
        self.assertFalse(status["connected"])
        self.assertEqual(status["agents"], [])

    def test_pick_agent_prefers_least_busy_ready(self) -> None:
        async def _run() -> None:
            ws_a = MagicMock()
            ws_b = MagicMock()
            a = await self.hub.register(ws_a, "a")
            b = await self.hub.register(ws_b, "b")
            a.capabilities = {"ready": True, "hostname": "host-a"}
            b.capabilities = {"ready": True, "hostname": "host-b"}
            b.pending["busy"] = MagicMock()
            picked = self.hub.pick_agent()
            self.assertIs(picked, a)

        asyncio.run(_run())

    def test_run_remote_disabled(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "0"}, clear=False):
            result = self.hub.run_remote(_job())
        self.assertFalse(result.success)
        self.assertIn("disabled", (result.error or "").lower())

    def test_run_remote_no_agent(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
            result = self.hub.run_remote(_job())
        self.assertFalse(result.success)
        self.assertIn("No local publisher agent", result.error or "")

    def test_run_remote_dispatches_and_collects_samples(self) -> None:
        loop = asyncio.new_event_loop()
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        self.hub.set_loop(loop)

        ws = MagicMock()
        ws.send_json = AsyncMock()

        async def _register() -> None:
            conn = await self.hub.register(ws, "agent-1")
            conn.capabilities = {"ready": True, "hostname": "laptop"}
            return conn

        conn = asyncio.run_coroutine_threadsafe(_register(), loop).result(timeout=5)
        samples: list[UploadSample] = []

        def worker() -> None:
            with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
                self._result = self.hub.run_remote(
                    _job("job-dispatch"),
                    on_sample=samples.append,
                )

        t = threading.Thread(target=worker)
        t.start()

        # Wait until hub registered the pending job, then inject agent traffic.
        for _ in range(50):
            if "job-dispatch" in conn.pending:
                break
            threading.Event().wait(0.05)
        else:
            self.fail("pending job never registered")

        async def _inject() -> None:
            await self.hub.handle_agent_message(
                conn,
                {
                    "type": "sample",
                    "job_id": "job-dispatch",
                    "sample": {
                        "elapsed_sec": 1,
                        "encoded_bitrate_kbps": 1000.0,
                        "fps": 30.0,
                        "fps_stability": 1.0,
                        "speed": 1.0,
                        "out_time": "00:00:01.000",
                        "cpu_percent": 5.0,
                        "memory_mb": 100.0,
                        "progress": "continue",
                    },
                },
            )
            await self.hub.handle_agent_message(
                conn,
                {
                    "type": "job_done",
                    "job_id": "job-dispatch",
                    "result": {"success": True, "csv_path": "/tmp/out.csv"},
                },
            )

        asyncio.run_coroutine_threadsafe(_inject(), loop).result(timeout=5)
        t.join(timeout=10)
        self.assertFalse(t.is_alive())

        self.assertTrue(self._result.success)
        self.assertEqual(self._result.csv_path, "/tmp/out.csv")
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0].elapsed_sec, 1)
        ws.send_json.assert_called()
        start_msg = ws.send_json.call_args.args[0]
        self.assertEqual(start_msg["type"], "job_start")
        self.assertEqual(start_msg["job_id"], "job-dispatch")

        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()


if __name__ == "__main__":
    unittest.main()
