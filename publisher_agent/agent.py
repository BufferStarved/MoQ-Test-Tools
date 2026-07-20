"""WebSocket client that runs UploadService jobs on this laptop."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional

# Repo layout: publisher_agent/ sits next to src/
ROOT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from publisher_protocol import (  # noqa: E402
    PROTOCOL_VERSION,
    result_to_dict,
    sample_to_dict,
    upload_job_from_dict,
)
from upload_service import UploadService  # noqa: E402

from publisher_agent.deps import check_all, ensure_tool_path, required_ok  # noqa: E402

logger = logging.getLogger("publisher-agent")


class PublisherAgent:
    def __init__(
        self,
        api_ws_url: str,
        token: str,
        *,
        agent_id: str = "",
        hostname: str = "",
    ) -> None:
        self.api_ws_url = api_ws_url
        self.token = token
        self.agent_id = agent_id or f"agent-{os.getpid()}"
        self.hostname = hostname or os.uname().nodename
        self._jobs: Dict[str, threading.Event] = {}
        self._jobs_lock = threading.Lock()
        self._service = UploadService()
        self._deps = check_all(ROOT_DIR)
        ensure_tool_path(self._deps)
        # Never hairpin MediaMTX to loopback on a laptop agent — publish to the
        # public ingest IP over the real internet path under test.
        os.environ.setdefault("MEDIAMTX_LOOPBACK_PUBLISH", "0")

    def capabilities(self) -> Dict[str, Any]:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "agent_id": self.agent_id,
            "hostname": self.hostname,
            "platform": sys.platform,
            "repo_root": str(ROOT_DIR),
            "deps": [
                {
                    "name": d.name,
                    "ok": d.ok,
                    "path": d.path,
                    "detail": d.detail,
                    "install_hint": d.install_hint,
                }
                for d in self._deps
            ],
            "ready": required_ok(self._deps),
        }

    async def run_forever(self) -> None:
        try:
            import websockets
        except ImportError as exc:
            raise SystemExit(
                "Missing dependency 'websockets'. Install with:\n"
                "  pip install websockets\n"
                f"({exc})"
            ) from exc

        if not required_ok(self._deps):
            for dep in self._deps:
                if dep.name == "ffmpeg" and not dep.ok:
                    raise SystemExit(
                        f"ffmpeg required but not ready: {dep.detail}\n"
                        f"  hint: {dep.install_hint}"
                    )

        url = self.api_ws_url
        sep = "&" if "?" in url else "?"
        connect_url = f"{url}{sep}token={self.token}&agent_id={self.agent_id}"
        logger.info("Connecting to %s", url)
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(
                    connect_url,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=8 * 1024 * 1024,
                ) as ws:
                    await ws.send(
                        json.dumps({"type": "hello", "capabilities": self.capabilities()})
                    )
                    logger.info("Connected as %s (%s)", self.agent_id, self.hostname)
                    backoff = 1.0
                    async for raw in ws:
                        try:
                            message = json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("Ignoring non-JSON message")
                            continue
                        await self._handle_message(ws, message)
            except Exception as exc:  # noqa: BLE001 — reconnect loop
                logger.warning("Disconnected (%s); retry in %.1fs", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 1.7)

    async def _handle_message(self, ws: Any, message: Dict[str, Any]) -> None:
        msg_type = str(message.get("type") or "")
        if msg_type == "ping":
            await ws.send(json.dumps({"type": "pong"}))
            return
        if msg_type == "job_start":
            job_payload = message.get("job") or {}
            job_id = str(job_payload.get("job_id") or message.get("job_id") or "")
            if not job_id:
                await ws.send(
                    json.dumps({"type": "job_error", "job_id": "", "error": "missing job_id"})
                )
                return
            cancel_event = threading.Event()
            with self._jobs_lock:
                self._jobs[job_id] = cancel_event
            thread = threading.Thread(
                target=self._run_job_thread,
                args=(asyncio.get_running_loop(), ws, job_payload, cancel_event),
                daemon=True,
                name=f"publish-{job_id[:8]}",
            )
            thread.start()
            return
        if msg_type == "job_cancel":
            job_id = str(message.get("job_id") or "")
            with self._jobs_lock:
                event = self._jobs.get(job_id)
            if event:
                event.set()
                logger.info("Cancel requested for %s", job_id)
            return
        logger.debug("Unhandled message type: %s", msg_type)

    def _run_job_thread(
        self,
        loop: asyncio.AbstractEventLoop,
        ws: Any,
        job_payload: Dict[str, Any],
        cancel_event: threading.Event,
    ) -> None:
        job_id = str(job_payload.get("job_id") or "")
        try:
            job = upload_job_from_dict(job_payload)
            job.cancel_event = cancel_event
            media_raw = (job.media_path or "").strip()
            if media_raw.lower().startswith("device:webcam"):
                job.media_path = "device:webcam"
            else:
                # Absolute uploads/ paths from the API, or repo-relative files.
                media = Path(media_raw)
                if not media.is_absolute():
                    candidate = ROOT_DIR / media_raw
                    if candidate.exists():
                        job.media_path = str(candidate)
                elif not media.exists():
                    raise FileNotFoundError(f"Local media not found on agent: {media_raw}")

            def on_sample(sample: Any) -> None:
                payload = {
                    "type": "sample",
                    "job_id": job_id,
                    "sample": sample_to_dict(sample),
                }
                fut = asyncio.run_coroutine_threadsafe(
                    ws.send(json.dumps(payload)),
                    loop,
                )
                try:
                    fut.result(timeout=5)
                except Exception:  # noqa: BLE001
                    logger.debug("Failed to send sample for %s", job_id)

            def on_preview(ready: bool) -> None:
                fut = asyncio.run_coroutine_threadsafe(
                    ws.send(
                        json.dumps(
                            {"type": "preview_ready", "job_id": job_id, "preview_ready": bool(ready)}
                        )
                    ),
                    loop,
                )
                try:
                    fut.result(timeout=5)
                except Exception:  # noqa: BLE001
                    pass

            def on_encoder_vmaf(status: str) -> None:
                fut = asyncio.run_coroutine_threadsafe(
                    ws.send(
                        json.dumps(
                            {
                                "type": "encoder_vmaf_status",
                                "job_id": job_id,
                                "encoder_vmaf_status": str(status),
                            }
                        )
                    ),
                    loop,
                )
                try:
                    fut.result(timeout=5)
                except Exception:  # noqa: BLE001
                    pass

            job.on_preview_ready = on_preview
            job.on_encoder_vmaf_status = on_encoder_vmaf

            logger.info(
                "Starting job %s %s → %s",
                job_id[:8],
                job.destination.protocol,
                job.destination.url[:80],
            )
            # Ensure CSV lands in the shared repo results/ when agent shares the tree.
            previous_cwd = os.getcwd()
            try:
                os.chdir(ROOT_DIR)
                result = self._service.run(job, on_sample=on_sample)
            finally:
                os.chdir(previous_cwd)

            done = {
                "type": "job_done",
                "job_id": job_id,
                "result": result_to_dict(result),
            }
            fut = asyncio.run_coroutine_threadsafe(ws.send(json.dumps(done)), loop)
            fut.result(timeout=30)
            logger.info("Job %s finished success=%s", job_id[:8], result.success)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Job %s failed", job_id[:8])
            err = {
                "type": "job_done",
                "job_id": job_id,
                "result": {
                    "success": False,
                    "error": str(exc),
                    "encoder_vmaf_status": "failed",
                },
            }
            try:
                fut = asyncio.run_coroutine_threadsafe(ws.send(json.dumps(err)), loop)
                fut.result(timeout=10)
            except Exception:  # noqa: BLE001
                pass
        finally:
            with self._jobs_lock:
                self._jobs.pop(job_id, None)


def default_ws_url(api_base: str = "http://127.0.0.1:8000") -> str:
    base = api_base.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :] + "/api/publisher-agent/ws"
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :] + "/api/publisher-agent/ws"
    if base.startswith("ws://") or base.startswith("wss://"):
        if base.endswith("/ws"):
            return base
        return base.rstrip("/") + "/api/publisher-agent/ws"
    return "ws://127.0.0.1:8000/api/publisher-agent/ws"
