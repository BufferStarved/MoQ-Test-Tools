"""Minimal obs-websocket 5 client (Identify + request/response)."""

from __future__ import annotations

import asyncio
import base64
import concurrent.futures
import errno
import hashlib
import json
import os
import uuid
from typing import Any, Dict, Optional


class ObsWebsocketError(RuntimeError):
    pass


def _obs_d18_note(endpoint: str) -> str:
    haystack = endpoint or ""
    if ":14433" not in haystack and "draft=18" not in haystack:
        return ""
    return (
        " openmoq-plugin speaks draft-16 / H.264; this destination is a "
        "draft-18-only relay (:14433). Use Webcam + ffmpeg for the d18 "
        "canary, or point OBS at prod :4433."
    )


def classify_obs_error(
    exc: BaseException,
    *,
    endpoint: str = "",
    request_type: str = "",
) -> str:
    """Human error for OBS WebSocket / StartStream / plugin failures.

    Bare ``[Errno 5] Input/output error`` used to leak through
    ``str(exc)`` and the UI called it ``publisher never started``.
    """
    text = str(exc).strip() or type(exc).__name__
    if text.lower().startswith("obs websocket") or text.lower().startswith("obs startstream"):
        return text
    if text.lower().startswith("obs openmoq"):
        return text
    err_no = getattr(exc, "errno", None)
    is_eio = err_no == errno.EIO or "input/output error" in text.lower()
    note = _obs_d18_note(endpoint)
    label = request_type or "request"
    if "StartStream" in (request_type or "") or "startstream" in text.lower():
        return f"OBS StartStream failed: {text}.{note}"
    if is_eio:
        return (
            f"OBS WebSocket I/O error ({text}). Check Tools → WebSocket Server "
            f"and that OBS is still running.{note}"
        )
    if isinstance(exc, ObsWebsocketError):
        return f"OBS WebSocket {label} failed: {text}.{note}"
    if isinstance(exc, OSError):
        return f"OBS WebSocket I/O error ({text}).{note}"
    return f"OBS OpenMOQ encode failed: {text}.{note}"


def _auth_string(password: str, salt: str, challenge: str) -> str:
    secret = base64.b64encode(
        hashlib.sha256((password + salt).encode("utf-8")).digest()
    )
    return base64.b64encode(
        hashlib.sha256(secret + challenge.encode("utf-8")).digest()
    ).decode("ascii")


class ObsWebsocket:
    def __init__(
        self,
        url: str = "",
        password: str = "",
    ) -> None:
        self.url = url or os.environ.get("OBS_WEBSOCKET_URL", "ws://127.0.0.1:4455")
        self.password = password or os.environ.get("OBS_WEBSOCKET_PASSWORD", "")
        self._ws: Any = None

    async def connect(self) -> None:
        try:
            import websockets
        except ImportError as exc:
            raise ObsWebsocketError("Missing dependency 'websockets'") from exc
        self._ws = await websockets.connect(self.url, open_timeout=3, close_timeout=2)
        hello = json.loads(await self._ws.recv())
        if hello.get("op") != 0:
            raise ObsWebsocketError(f"Unexpected OBS hello: {hello}")
        identify: Dict[str, Any] = {"rpcVersion": 1}
        auth = (hello.get("d") or {}).get("authentication")
        if auth:
            if not self.password:
                raise ObsWebsocketError(
                    "OBS WebSocket requires a password. Set OBS_WEBSOCKET_PASSWORD."
                )
            identify["authentication"] = _auth_string(
                self.password,
                str(auth.get("salt") or ""),
                str(auth.get("challenge") or ""),
            )
        await self._ws.send(json.dumps({"op": 1, "d": identify}))
        identified = json.loads(await asyncio.wait_for(self._ws.recv(), timeout=3))
        if identified.get("op") != 2:
            raise ObsWebsocketError(f"OBS Identify failed: {identified}")

    async def close(self) -> None:
        if self._ws is not None:
            await self._ws.close()
            self._ws = None

    async def request(self, request_type: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self._ws is None:
            raise ObsWebsocketError("Not connected to OBS")
        request_id = uuid.uuid4().hex
        payload: Dict[str, Any] = {
            "op": 6,
            "d": {"requestType": request_type, "requestId": request_id},
        }
        if data:
            payload["d"]["requestData"] = data
        await self._ws.send(json.dumps(payload))
        while True:
            raw = await asyncio.wait_for(self._ws.recv(), timeout=8)
            message = json.loads(raw)
            if message.get("op") != 7:
                continue
            body = message.get("d") or {}
            if body.get("requestId") != request_id:
                continue
            status = body.get("requestStatus") or {}
            if not status.get("result"):
                comment = status.get("comment") or status.get("code")
                raise ObsWebsocketError(f"{request_type} failed: {comment}")
            return body.get("responseData") or {}


def obs_request_sync(
    request_type: str,
    data: Optional[Dict[str, Any]] = None,
    *,
    url: str = "",
    password: str = "",
) -> Dict[str, Any]:
    async def _run() -> Dict[str, Any]:
        client = ObsWebsocket(url=url, password=password)
        await client.connect()
        try:
            return await client.request(request_type, data)
        finally:
            await client.close()

    def _call() -> Dict[str, Any]:
        return asyncio.run(_run())

    try:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return _call()
        # Hello / capability refresh runs on the agent event loop. asyncio.run
        # from that thread raises and used to leave websocket=false forever.
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_call).result(timeout=15)
    except ObsWebsocketError:
        raise
    except OSError as exc:
        raise ObsWebsocketError(
            classify_obs_error(exc, endpoint=url, request_type=request_type)
        ) from exc
    except Exception as exc:  # noqa: BLE001 — websockets ConnectionClosed / timeout
        raise ObsWebsocketError(
            classify_obs_error(exc, endpoint=url, request_type=request_type)
        ) from exc
