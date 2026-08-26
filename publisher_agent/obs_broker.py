"""Share one OBS encode (OpenMOQ Stream + extra SRT/RTMP) across sibling jobs."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from encode_profile import resolve_encode_ladder
from publisher_agent.obs_probe import find_openmoq_plugin
from publisher_agent.obs_websocket import classify_obs_error, obs_request_sync

logger = logging.getLogger("publisher-agent.obs-broker")

JOIN_WINDOW_SEC = 0.4
ACQUIRE_TIMEOUT_SEC = 20.0
OUTPUTS_PATH = Path.home() / ".moq-test-tools" / "obs-outputs.json"


@dataclass
class _Session:
    key: str
    ready: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    started: bool = False
    error: str = ""
    refcount: int = 0
    generation: str = ""


def _write_extra_outputs(*, srt_url: str, rtmp_url: str, active: bool, generation: str) -> None:
    OUTPUTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "active": bool(active),
        "generation": generation,
        "srt_url": srt_url,
        "rtmp_url": rtmp_url,
    }
    OUTPUTS_PATH.write_text(json.dumps(payload) + "\n", encoding="utf-8")


class ObsBroker:
    def __init__(self) -> None:
        self._sessions: Dict[str, _Session] = {}
        self._sessions_lock = threading.Lock()

    def acquire(
        self,
        comparison_id: str,
        *,
        protocol: str,
        publish_url: str,
        moq_endpoint: str = "",
        moq_namespace: str = "",
        encode_ladder: str = "720p",
        cancel_event: Optional[threading.Event] = None,
    ) -> _Session:
        key = (comparison_id or "obs-default").strip() or "obs-default"
        with self._sessions_lock:
            session = self._sessions.get(key)
            if session is None:
                session = _Session(key=key, generation=uuid.uuid4().hex)
                self._sessions[key] = session
                threading.Thread(
                    target=self._start_after_join_window,
                    args=(session,),
                    daemon=True,
                    name="obs-broker-start",
                ).start()
            session.refcount += 1
            self._pending(session, protocol, publish_url, moq_endpoint, moq_namespace, encode_ladder)

        try:
            deadline = time.monotonic() + ACQUIRE_TIMEOUT_SEC
            while not session.ready.is_set():
                if cancel_event is not None and cancel_event.is_set():
                    raise RuntimeError("Cancelled while starting OBS")
                if time.monotonic() > deadline:
                    raise RuntimeError("Timed out starting OBS OpenMOQ outputs")
                session.ready.wait(timeout=0.2)
            if session.error:
                raise RuntimeError(session.error)
        except Exception:
            self.release(session)
            raise
        return session

    def release(self, session: _Session) -> None:
        should_stop = False
        with self._sessions_lock:
            session.refcount -= 1
            if session.refcount <= 0:
                should_stop = True
                if self._sessions.get(session.key) is session:
                    self._sessions.pop(session.key, None)
        if should_stop:
            self._stop(session)

    def _pending(
        self,
        session: _Session,
        protocol: str,
        publish_url: str,
        moq_endpoint: str,
        moq_namespace: str,
        encode_ladder: str,
    ) -> None:
        with session.lock:
            extras: Dict[str, Any] = getattr(session, "plan", {})
            extras.setdefault("srt_url", "")
            extras.setdefault("rtmp_url", "")
            extras.setdefault("moq_endpoint", "")
            extras.setdefault("moq_namespace", "")
            extras["encode_ladder"] = encode_ladder
            proto = (protocol or "").lower()
            if proto == "srt":
                extras["srt_url"] = publish_url
            elif proto == "rtmp":
                extras["rtmp_url"] = publish_url
            elif proto == "moq":
                extras["moq_endpoint"] = moq_endpoint or publish_url
                extras["moq_namespace"] = moq_namespace or "benchmark"
            session.plan = extras  # type: ignore[attr-defined]

    def _start_after_join_window(self, session: _Session) -> None:
        time.sleep(JOIN_WINDOW_SEC)
        with session.lock:
            if session.started:
                return
            session.started = True
            plan: Dict[str, Any] = getattr(session, "plan", {})
        try:
            self._start_obs(session, plan)
        except Exception as exc:  # noqa: BLE001
            session.error = str(exc)
            logger.exception("OBS broker failed to start")
        finally:
            session.ready.set()

    def _start_obs(self, session: _Session, plan: Dict[str, Any]) -> None:
        ladder = resolve_encode_ladder(str(plan.get("encode_ladder") or "720p"))
        moq_endpoint = str(plan.get("moq_endpoint") or "")
        moq_namespace = str(plan.get("moq_namespace") or "benchmark")
        if not moq_endpoint:
            raise RuntimeError(
                "OBS OpenMOQ encode needs a MoQ output in the recipe "
                "(plugin uses Settings → Stream)."
            )
        if not find_openmoq_plugin():
            raise RuntimeError(
                "OBS openmoq-plugin was not found on disk. Install the plugin "
                "and reload OBS; this is not a missing moq5-fmp4-publish binary."
            )
        if ":14433" in moq_endpoint or "draft=18" in moq_endpoint:
            raise RuntimeError(
                "OBS StartStream failed: openmoq-plugin speaks draft-16 / H.264 "
                f"and cannot publish to a draft-18-only relay ({moq_endpoint}). "
                "Use Webcam + ffmpeg for the :14433 canary, or point OBS at prod :4433."
            )
        try:
            obs_request_sync(
                "SetProfileParameter",
                {
                    "parameterCategory": "SimpleOutput",
                    "parameterName": "VBitrate",
                    "parameterValue": str(ladder.bitrate_kbps),
                },
            )
            obs_request_sync(
                "SetStreamServiceSettings",
                {
                    "streamServiceType": "MOQ",
                    "streamServiceSettings": {
                        "server": moq_endpoint,
                        "key": moq_namespace,
                    },
                },
            )
            _write_extra_outputs(
                srt_url=str(plan.get("srt_url") or ""),
                rtmp_url=str(plan.get("rtmp_url") or ""),
                active=True,
                generation=session.generation,
            )
            status = obs_request_sync("GetStreamStatus")
            if not status.get("outputActive"):
                obs_request_sync("StartStream")
            status = obs_request_sync("GetStreamStatus")
            if not status.get("outputActive"):
                raise RuntimeError(
                    classify_obs_error(
                        RuntimeError("outputActive=false after StartStream"),
                        endpoint=moq_endpoint,
                        request_type="StartStream",
                    )
                )
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                classify_obs_error(exc, endpoint=moq_endpoint)
            ) from exc
        logger.info(
            "OBS OpenMOQ stream started ns=%s srt=%s rtmp=%s",
            moq_namespace,
            bool(plan.get("srt_url")),
            bool(plan.get("rtmp_url")),
        )

    def _stop(self, session: _Session) -> None:
        try:
            _write_extra_outputs(srt_url="", rtmp_url="", active=False, generation=session.generation)
            status = obs_request_sync("GetStreamStatus")
            if status.get("outputActive"):
                obs_request_sync("StopStream")
        except Exception:  # noqa: BLE001
            logger.warning("OBS broker stop failed", exc_info=True)


obs_broker = ObsBroker()
