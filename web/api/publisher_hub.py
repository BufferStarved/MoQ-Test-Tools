"""In-process hub for connected local publisher agents.

Enabled only when LOCAL_PUBLISHER_ENABLED=1 (scripts/dev.sh sets this).
Hosted/prod installs leave it off so the cloud VM keeps encoding locally.
"""

from __future__ import annotations

import asyncio
import logging
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from fastapi import WebSocket
from publisher_protocol import result_from_dict, upload_job_to_dict
from upload_service import UploadJob, UploadResult, UploadSample

logger = logging.getLogger("publisher-hub")

SampleCallback = Callable[[UploadSample], None]


def local_publisher_enabled() -> bool:
    raw = (os.environ.get("LOCAL_PUBLISHER_ENABLED") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def local_publisher_token() -> str:
    return (os.environ.get("LOCAL_PUBLISHER_TOKEN") or "dev-local-publisher").strip()


@dataclass
class _PendingJob:
    sample_queue: "queue.Queue[Optional[dict]]" = field(default_factory=queue.Queue)
    result_queue: "queue.Queue[dict]" = field(default_factory=queue.Queue)
    preview_ready: Optional[bool] = None
    encoder_vmaf_status: Optional[str] = None


@dataclass
class AgentConnection:
    agent_id: str
    hostname: str
    websocket: WebSocket
    capabilities: Dict[str, Any] = field(default_factory=dict)
    connected_at: float = field(default_factory=time.time)
    pending: Dict[str, _PendingJob] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


class PublisherHub:
    def __init__(self) -> None:
        self._agents: Dict[str, AgentConnection] = {}
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def status(self) -> Dict[str, Any]:
        with self._lock:
            agents = [
                {
                    "agent_id": agent.agent_id,
                    "hostname": agent.hostname,
                    "ready": bool((agent.capabilities or {}).get("ready")),
                    "platform": (agent.capabilities or {}).get("platform"),
                    "deps": (agent.capabilities or {}).get("deps") or [],
                    "connected_at": agent.connected_at,
                    "active_jobs": len(agent.pending),
                }
                for agent in self._agents.values()
            ]
        return {
            "enabled": local_publisher_enabled(),
            "connected": len(agents) > 0,
            "agents": agents,
        }

    def pick_agent(self) -> Optional[AgentConnection]:
        with self._lock:
            ready = [
                agent
                for agent in self._agents.values()
                if agent.capabilities and bool(agent.capabilities.get("ready"))
            ]
            if not ready:
                return None
            # Prefer the least-busy agent (comparison legs run in parallel).
            ready.sort(key=lambda item: len(item.pending))
            return ready[0]

    async def register(self, websocket: WebSocket, agent_id: str) -> AgentConnection:
        self._loop = asyncio.get_running_loop()
        conn = AgentConnection(agent_id=agent_id, hostname="", websocket=websocket)
        with self._lock:
            # Replace prior connection for the same agent id.
            self._agents[agent_id] = conn
        logger.info("Publisher agent connected: %s", agent_id)
        return conn

    def unregister(self, agent_id: str, websocket: WebSocket) -> None:
        with self._lock:
            current = self._agents.get(agent_id)
            if current and current.websocket is websocket:
                self._agents.pop(agent_id, None)
                logger.info("Publisher agent disconnected: %s", agent_id)

    async def handle_agent_message(self, conn: AgentConnection, message: Dict[str, Any]) -> None:
        msg_type = str(message.get("type") or "")
        if msg_type == "hello":
            caps = message.get("capabilities") or {}
            conn.capabilities = caps if isinstance(caps, dict) else {}
            conn.hostname = str(caps.get("hostname") or conn.agent_id)
            logger.info(
                "Agent hello %s ready=%s deps=%s",
                conn.agent_id,
                caps.get("ready"),
                [d.get("name") for d in (caps.get("deps") or []) if isinstance(d, dict)],
            )
            return
        if msg_type == "pong":
            return

        job_id = str(message.get("job_id") or "")
        with conn.lock:
            pending = conn.pending.get(job_id) if job_id else None

        if msg_type == "sample" and pending is not None:
            sample = message.get("sample") or {}
            if isinstance(sample, dict):
                pending.sample_queue.put(sample)
            return
        if msg_type == "preview_ready" and pending is not None:
            pending.preview_ready = bool(message.get("preview_ready"))
            if conn.pending.get(job_id):  # keep latest
                pass
            return
        if msg_type == "encoder_vmaf_status" and pending is not None:
            pending.encoder_vmaf_status = str(message.get("encoder_vmaf_status") or "")
            return
        if msg_type == "job_done" and pending is not None:
            pending.result_queue.put(message.get("result") or {})
            pending.sample_queue.put(None)  # unblock sample waiter
            return
        if msg_type == "job_error" and pending is not None:
            pending.result_queue.put(
                {"success": False, "error": str(message.get("error") or "agent error")}
            )
            pending.sample_queue.put(None)
            return

    def run_remote(
        self,
        job: UploadJob,
        *,
        on_sample: Optional[SampleCallback] = None,
        on_preview_ready: Optional[Callable[[bool], None]] = None,
        on_encoder_vmaf_status: Optional[Callable[[str], None]] = None,
    ) -> UploadResult:
        if not local_publisher_enabled():
            return UploadResult(
                success=False,
                error="Local publisher is disabled (set LOCAL_PUBLISHER_ENABLED=1).",
            )
        agent = self.pick_agent()
        if agent is None:
            return UploadResult(
                success=False,
                error=(
                    "No local publisher agent connected. "
                    "In another terminal run: ./scripts/run-local-publisher.sh"
                ),
            )
        if not job.job_id:
            job.job_id = str(uuid.uuid4())

        pending = _PendingJob()
        with agent.lock:
            agent.pending[job.job_id] = pending

        loop = self._loop
        if loop is None:
            with agent.lock:
                agent.pending.pop(job.job_id, None)
            return UploadResult(success=False, error="Publisher hub event loop not ready.")

        start_msg = {"type": "job_start", "job_id": job.job_id, "job": upload_job_to_dict(job)}
        try:
            fut = asyncio.run_coroutine_threadsafe(
                agent.websocket.send_json(start_msg),
                loop,
            )
            fut.result(timeout=10)
        except Exception as exc:  # noqa: BLE001
            with agent.lock:
                agent.pending.pop(job.job_id, None)
            return UploadResult(success=False, error=f"Failed to dispatch to agent: {exc}")

        result_payload: Optional[dict] = None
        try:
            while True:
                if job.is_cancelled():
                    try:
                        asyncio.run_coroutine_threadsafe(
                            agent.websocket.send_json(
                                {"type": "job_cancel", "job_id": job.job_id}
                            ),
                            loop,
                        ).result(timeout=5)
                    except Exception:  # noqa: BLE001
                        pass

                # Drain preview / encoder status side-channels.
                if pending.preview_ready is not None and on_preview_ready:
                    on_preview_ready(bool(pending.preview_ready))
                    pending.preview_ready = None
                if pending.encoder_vmaf_status is not None and on_encoder_vmaf_status:
                    on_encoder_vmaf_status(pending.encoder_vmaf_status)
                    pending.encoder_vmaf_status = None

                try:
                    item = pending.sample_queue.get(timeout=0.5)
                except queue.Empty:
                    try:
                        result_payload = pending.result_queue.get_nowait()
                        break
                    except queue.Empty:
                        continue

                if item is None:
                    try:
                        result_payload = pending.result_queue.get(timeout=5)
                    except queue.Empty:
                        result_payload = {
                            "success": False,
                            "error": "Agent ended without a result payload.",
                        }
                    break

                if on_sample and isinstance(item, dict):
                    try:
                        on_sample(UploadSample(**_sample_kwargs(item)))
                    except TypeError:
                        # Ignore unknown/missing fields from newer agents.
                        filtered = {
                            key: item[key]
                            for key in UploadSample.__dataclass_fields__
                            if key in item
                        }
                        on_sample(UploadSample(**filtered))
        finally:
            with agent.lock:
                agent.pending.pop(job.job_id, None)

        return result_from_dict(result_payload)


def _sample_kwargs(data: Dict[str, Any]) -> Dict[str, Any]:
    fields = UploadSample.__dataclass_fields__
    return {key: data[key] for key in fields if key in data}


publisher_hub = PublisherHub()
