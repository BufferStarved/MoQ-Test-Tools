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
            with patch.dict(
                os.environ,
                {"LOCAL_PUBLISHER_ENABLED": value, "MOQ_ENV": "dev"},
                clear=False,
            ):
                self.assertTrue(local_publisher_enabled(), msg=value)

    def test_disabled_falsy(self) -> None:
        for value in ("0", "false", "no", "off"):
            with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": value}, clear=False):
                self.assertFalse(local_publisher_enabled(), msg=repr(value))

    def test_default_enabled_when_unset(self) -> None:
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in {"LOCAL_PUBLISHER_ENABLED", "MOQ_ENV"}
        }
        with patch.dict(os.environ, env, clear=True):
            self.assertTrue(local_publisher_enabled())

    def test_prod_feature_stays_on_for_session_helpers(self) -> None:
        with patch.dict(
            os.environ,
            {"MOQ_ENV": "prod", "LOCAL_PUBLISHER_ENABLED": "0", "LOCAL_PUBLISHER_TOKEN": "dev-local-publisher"},
            clear=False,
        ):
            self.assertTrue(local_publisher_enabled())

    def test_default_enabled_in_prod_when_unset(self) -> None:
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in {"LOCAL_PUBLISHER_ENABLED", "MOQ_ENV"}
        }
        env["MOQ_ENV"] = "prod"
        with patch.dict(os.environ, env, clear=True):
            self.assertTrue(local_publisher_enabled())


class PublisherHubTests(unittest.TestCase):
    def setUp(self) -> None:
        self.hub = PublisherHub()

    def test_status_empty(self) -> None:
        with patch.dict(os.environ, {"LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
            status = self.hub.status()
        self.assertTrue(status["enabled"])
        self.assertFalse(status["connected"])
        self.assertEqual(status["agents"], [])

    def test_prod_session_never_picks_another_users_helper(self) -> None:
        with patch.dict(os.environ, {"MOQ_ENV": "prod"}, clear=False):
            async def _run() -> None:
                sess_a = self.hub.mint_session().session_id
                sess_b = self.hub.mint_session().session_id
                a = await self.hub.register(MagicMock(), "a", session_id=sess_a)
                b = await self.hub.register(MagicMock(), "b", session_id=sess_b)
                a.capabilities = {"ready": True, "hostname": "host-a"}
                b.capabilities = {"ready": True, "hostname": "host-b"}
                self.assertIs(self.hub.pick_agent(session_id=sess_a), a)
                self.assertIs(self.hub.pick_agent(session_id=sess_b), b)
                self.assertIsNone(self.hub.pick_agent())
                leaked = self.hub.status()
                self.assertEqual(leaked["agents"], [])
                own = self.hub.status(sess_a)
                self.assertEqual(len(own["agents"]), 1)
                self.assertEqual(own["agents"][0]["agent_id"], "a")

            asyncio.run(_run())

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

    def test_pick_agent_pins_comparison_to_one_helper(self) -> None:
        async def _run() -> None:
            ws_a = MagicMock()
            ws_b = MagicMock()
            a = await self.hub.register(ws_a, "a")
            b = await self.hub.register(ws_b, "b")
            a.capabilities = {"ready": True, "hostname": "host-a"}
            b.capabilities = {"ready": True, "hostname": "host-b"}
            first = self.hub.pick_agent("cmp-1")
            first.pending["busy"] = MagicMock()
            second = self.hub.pick_agent("cmp-1")
            other = self.hub.pick_agent("cmp-2")
            self.assertIs(second, first)
            self.assertIs(other, b if first is a else a)

        asyncio.run(_run())

    def test_pick_agent_repins_when_sticky_helper_disconnects(self) -> None:
        async def _run() -> None:
            ws_a = MagicMock()
            ws_b = MagicMock()
            a = await self.hub.register(ws_a, "a")
            b = await self.hub.register(ws_b, "b")
            a.capabilities = {"ready": True}
            b.capabilities = {"ready": True}
            first = self.hub.pick_agent("cmp-sticky")
            self.hub.unregister(first.agent_id, first.websocket)
            leftover = self.hub.pick_agent("cmp-sticky")
            self.assertIsNotNone(leftover)
            self.assertIsNot(leftover, first)

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

    def test_broadcast_cancel_fans_out_without_pending_job(self) -> None:
        loop = asyncio.new_event_loop()
        thread = threading.Thread(target=loop.run_forever, daemon=True)
        thread.start()
        self.hub.set_loop(loop)
        ws = MagicMock()
        ws.send_json = AsyncMock()

        async def _register() -> None:
            await self.hub.register(ws, "helper")

        asyncio.run_coroutine_threadsafe(_register(), loop).result(timeout=2)
        sent = self.hub.broadcast_cancel("ghost-job")
        self.assertEqual(sent, 1)
        ws.send_json.assert_awaited()
        self.assertEqual(ws.send_json.await_args.args[0]["type"], "job_cancel")
        self.assertEqual(ws.send_json.await_args.args[0]["job_id"], "ghost-job")

        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=2)
        loop.close()

    def test_run_remote_rejects_stale_helper_in_prod(self) -> None:
        async def _run() -> None:
            sess = self.hub.mint_session().session_id
            conn = await self.hub.register(MagicMock(), "stale", session_id=sess)
            conn.capabilities = {"ready": True, "git_sha": "deadbeef"}
            job = _job("job-stale")
            job.publisher_session = sess
            with patch.dict(os.environ, {"MOQ_ENV": "prod", "LOCAL_PUBLISHER_ENABLED": "1"}, clear=False):
                with patch("build_info.read_build_sha", return_value="cafebabe"):
                    result = self.hub.run_remote(job)
            self.assertFalse(result.success)
            self.assertIn("deadbeef", result.error or "")
            self.assertIn("cafebabe", result.error or "")
            self.assertIn("SPA refresh", result.error or "")

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
