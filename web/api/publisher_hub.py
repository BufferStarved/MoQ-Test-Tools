"""In-process hub for connected local publisher agents.

Webcam+ffmpeg runs on the machine that started the helper — that user's
camera. Jobs must only dispatch to the helper bound to the same browser
session. A shared pool (one laptop serving every visitor) is never allowed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import queue
import secrets
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


def _is_prod_env() -> bool:
    return (os.environ.get("MOQ_ENV") or "").strip().lower() in {"prod", "production"}


def local_publisher_token() -> str:
    default = "" if _is_prod_env() else "dev-local-publisher"
    return (os.environ.get("LOCAL_PUBLISHER_TOKEN") or default).strip()


def local_publisher_enabled() -> bool:
    """Webcam+ffmpeg last-mile is on. Prod uses per-browser sessions only."""
    if _is_prod_env():
        return True
    raw = (os.environ.get("LOCAL_PUBLISHER_ENABLED") or "").strip().lower()
    if not raw:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return True


PUBLISHER_SESSION_TTL_SEC = 12 * 3600


def normalize_publisher_session(raw: Optional[str]) -> str:
    return (raw or "").strip()


def capabilities_allow_whip(capabilities: Optional[Dict[str, Any]]) -> bool:
    """True only when the agent has proven it can mux `-f whip`. Fail closed."""
    caps = capabilities or {}
    if "ffmpeg_whip" in caps:
        return bool(caps.get("ffmpeg_whip"))
    for dep in caps.get("deps") or []:
        if not isinstance(dep, dict):
            continue
        if dep.get("name") == "ffmpeg-whip":
            return bool(dep.get("ok"))
        detail = str(dep.get("detail") or "").lower()
        if dep.get("name") == "ffmpeg" and "whip" in detail and "missing" in detail:
            return False
    return False


@dataclass
class _PendingJob:
    sample_queue: "queue.Queue[Optional[dict]]" = field(default_factory=queue.Queue)
    result_queue: "queue.Queue[dict]" = field(default_factory=queue.Queue)
    preview_ready: Optional[bool] = None
    encoder_vmaf_status: Optional[str] = None
    media_zero_epoch: Optional[float] = None
    packager_transit_ms: Optional[float] = None
    delivery_media_origin_sec: Optional[float] = None


@dataclass
class PublisherSession:
    session_id: str
    created_at: float
    expires_at: float


@dataclass
class AgentConnection:
    agent_id: str
    hostname: str
    websocket: WebSocket
    session_id: str = ""
    capabilities: Dict[str, Any] = field(default_factory=dict)
    connected_at: float = field(default_factory=time.time)
    pending: Dict[str, _PendingJob] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


class PublisherHub:
    def __init__(self) -> None:
        self._agents: Dict[str, AgentConnection] = {}
        self._comparison_agents: Dict[str, str] = {}
        self._sessions: Dict[str, PublisherSession] = {}
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def mint_session(self) -> PublisherSession:
        now = time.time()
        session = PublisherSession(
            session_id=secrets.token_urlsafe(32),
            created_at=now,
            expires_at=now + PUBLISHER_SESSION_TTL_SEC,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def valid_session(self, session_id: str) -> bool:
        sid = normalize_publisher_session(session_id)
        if not sid:
            return False
        now = time.time()
        with self._lock:
            session = self._sessions.get(sid)
            if session is None or session.expires_at < now:
                self._sessions.pop(sid, None)
                return False
            return True

    def _visible_agents(self, session_id: str = "") -> List[AgentConnection]:
        sid = normalize_publisher_session(session_id)
        if sid:
            return [agent for agent in self._agents.values() if agent.session_id == sid]
        if _is_prod_env():
            return []
        return list(self._agents.values())

    def status(self, session_id: str = "") -> Dict[str, Any]:
        with self._lock:
            agents = [
                {
                    "agent_id": agent.agent_id,
                    "hostname": agent.hostname,
                    "ready": bool((agent.capabilities or {}).get("ready")),
                    "platform": (agent.capabilities or {}).get("platform"),
                    "deps": (agent.capabilities or {}).get("deps") or [],
                    "webcam_devices": (agent.capabilities or {}).get("webcam_devices") or [],
                    "ffmpeg_whip": capabilities_allow_whip(agent.capabilities),
                    "obs_websocket": bool((agent.capabilities or {}).get("obs_websocket")),
                    "obs_plugin": bool((agent.capabilities or {}).get("obs_plugin")),
                    "obs_detail": (agent.capabilities or {}).get("obs_detail") or "",
                    "connected_at": agent.connected_at,
                    "active_jobs": len(agent.pending),
                }
                for agent in self._visible_agents(session_id)
            ]
        return {
            "enabled": local_publisher_enabled(),
            "connected": len(agents) > 0,
            "whip": any(bool(agent.get("ffmpeg_whip")) for agent in agents),
            "obs": {
                "websocket": any(bool(agent.get("obs_websocket")) for agent in agents),
                "plugin": any(bool(agent.get("obs_plugin")) for agent in agents),
                "detail": next(
                    (
                        str(agent.get("obs_detail") or "")
                        for agent in agents
                        if agent.get("obs_detail")
                    ),
                    "",
                ),
            },
            "agents": agents,
        }

    def can_publish_whip(self, session_id: str = "") -> bool:
        agent = self.pick_agent(session_id=session_id)
        if agent is not None:
            return capabilities_allow_whip(agent.capabilities)
        with self._lock:
            return any(
                capabilities_allow_whip(item.capabilities)
                for item in self._visible_agents(session_id)
            )

    def broadcast_cancel(self, job_id: str) -> int:
        """Ask every connected helper to stop this job.

        After an API restart JobManager no longer has the record, but the
        laptop agent may still be encoding. Fan-out by job_id.
        """
        job_id = (job_id or "").strip()
        if not job_id:
            return 0
        loop = self._loop
        with self._lock:
            agents = list(self._agents.values())
        if not agents or loop is None:
            return 0
        payload = {"type": "job_cancel", "job_id": job_id}
        sent = 0
        for agent in agents:
            try:
                asyncio.run_coroutine_threadsafe(
                    agent.websocket.send_json(payload),
                    loop,
                ).result(timeout=5)
                sent += 1
            except Exception:  # noqa: BLE001
                logger.warning("Failed to send job_cancel to %s", agent.agent_id, exc_info=True)
        return sent

    def pick_agent(
        self,
        comparison_id: str = "",
        session_id: str = "",
    ) -> Optional[AgentConnection]:
        sid = normalize_publisher_session(session_id)
        if _is_prod_env() and not sid:
            return None
        with self._lock:
            ready = [
                agent
                for agent in self._visible_agents(sid)
                if agent.capabilities and bool(agent.capabilities.get("ready"))
            ]
            if not ready:
                return None
            cid = (comparison_id or "").strip()
            pin_key = f"{sid}:{cid}" if sid else cid
            if cid:
                sticky_id = self._comparison_agents.get(pin_key)
                if sticky_id:
                    for agent in ready:
                        if agent.agent_id == sticky_id:
                            return agent
            # Prefer the least-busy helper in *this* session only.
            ready.sort(key=lambda item: len(item.pending))
            picked = ready[0]
            if cid:
                self._comparison_agents[pin_key] = picked.agent_id
            return picked

    async def register(
        self,
        websocket: WebSocket,
        agent_id: str,
        session_id: str = "",
    ) -> AgentConnection:
        self._loop = asyncio.get_running_loop()
        conn = AgentConnection(
            agent_id=agent_id,
            hostname="",
            websocket=websocket,
            session_id=normalize_publisher_session(session_id),
        )
        with self._lock:
            # Replace prior connection for the same agent id.
            self._agents[agent_id] = conn
        logger.info(
            "Publisher agent connected: %s session=%s",
            agent_id,
            conn.session_id or "-",
        )
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
        if msg_type == "media_zero" and pending is not None:
            try:
                pending.media_zero_epoch = float(message.get("media_zero_epoch"))
            except (TypeError, ValueError):
                pass
            return
        if msg_type == "packager_transit" and pending is not None:
            try:
                pending.packager_transit_ms = float(message.get("packager_transit_ms"))
            except (TypeError, ValueError):
                pass
            return
        if msg_type == "delivery_media_origin" and pending is not None:
            try:
                pending.delivery_media_origin_sec = float(
                    message.get("delivery_media_origin_sec")
                )
            except (TypeError, ValueError):
                pass
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
        on_media_zero: Optional[Callable[[float], None]] = None,
        on_packager_transit: Optional[Callable[[float], None]] = None,
        on_delivery_media_origin: Optional[Callable[[float], None]] = None,
    ) -> UploadResult:
        if not local_publisher_enabled():
            return UploadResult(
                success=False,
                error="Local publisher is disabled (set LOCAL_PUBLISHER_ENABLED=1).",
            )
        agent = self.pick_agent(
            getattr(job, "comparison_id", "") or "",
            getattr(job, "publisher_session", "") or "",
        )
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
                if pending.media_zero_epoch is not None and on_media_zero:
                    on_media_zero(pending.media_zero_epoch)
                    pending.media_zero_epoch = None
                if pending.packager_transit_ms is not None and on_packager_transit:
                    on_packager_transit(pending.packager_transit_ms)
                    pending.packager_transit_ms = None
                if (
                    pending.delivery_media_origin_sec is not None
                    and on_delivery_media_origin
                ):
                    on_delivery_media_origin(pending.delivery_media_origin_sec)
                    pending.delivery_media_origin_sec = None

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
