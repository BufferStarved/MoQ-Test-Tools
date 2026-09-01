"""WebSocket client that runs UploadService jobs on this laptop."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
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

from publisher_agent.api_guard import assert_publisher_api_allowed  # noqa: E402
from publisher_agent.deps import (  # noqa: E402
    check_all,
    ensure_tool_path,
    list_webcam_devices,
    required_ok,
)
from publisher_agent.obs_broker import obs_broker  # noqa: E402
from publisher_agent.obs_probe import probe_obs  # noqa: E402
from publisher_agent.obs_websocket import classify_obs_error  # noqa: E402
from publisher_agent.webcam_broker import webcam_broker  # noqa: E402
from moq_publish import (  # noqa: E402
    classify_job_exception,
    classify_result_error,
    is_device_webcam_source,
    is_obs_openmoq_source,
)

logger = logging.getLogger("publisher-agent")


def _helper_git_sha() -> str:
    env_sha = (os.environ.get("MOQ_HELPER_GIT_SHA") or "").strip()
    if env_sha:
        return env_sha
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT_DIR,
            text=True,
            timeout=2,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


class PublisherAgent:
    def __init__(
        self,
        api_ws_url: str,
        token: str,
        *,
        agent_id: str = "",
        hostname: str = "",
        session: str = "",
    ) -> None:
        self.session = (session or os.environ.get("LOCAL_PUBLISHER_SESSION") or "").strip()
        assert_publisher_api_allowed(api_ws_url, self.session)
        self.api_ws_url = api_ws_url
        self.token = token
        self.agent_id = agent_id or f"agent-{os.getpid()}"
        self.hostname = hostname or os.uname().nodename
        self._jobs: Dict[str, threading.Event] = {}
        self._jobs_lock = threading.Lock()
        self._service = UploadService()
        self._deps = check_all(ROOT_DIR)
        ensure_tool_path(self._deps)
        ffmpeg_path = next(
            (dep.path for dep in self._deps if dep.name == "ffmpeg" and dep.ok), ""
        )
        self._ffmpeg_whip = any(dep.name == "ffmpeg-whip" and dep.ok for dep in self._deps)
        self._webcam_devices = list_webcam_devices(ffmpeg_path)
        self._obs = probe_obs()
        # Never hairpin MediaMTX to loopback on a laptop agent — publish to the
        # public ingest IP over the real internet path under test.
        os.environ.setdefault("MEDIAMTX_LOOPBACK_PUBLISH", "0")

    def capabilities(self, *, refresh_obs: bool = False) -> Dict[str, Any]:
        if refresh_obs:
            try:
                self._obs = probe_obs()
            except Exception as exc:  # noqa: BLE001 — keep last snapshot
                logger.debug("OBS re-probe failed: %s", exc)
        return {
            "protocol_version": PROTOCOL_VERSION,
            "agent_id": self.agent_id,
            "hostname": self.hostname,
            "platform": sys.platform,
            "repo_root": str(ROOT_DIR),
            "git_sha": _helper_git_sha(),
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
            "webcam_devices": self._webcam_devices,
            "ffmpeg_whip": self._ffmpeg_whip,
            "obs_websocket": bool(self._obs.get("obs_websocket")),
            "obs_plugin": bool(self._obs.get("obs_plugin")),
            "obs_detail": self._obs.get("obs_detail") or "",
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
        if self.session:
            connect_url = f"{connect_url}&session={self.session}"
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
                    refresh = asyncio.create_task(self._obs_refresh_loop(ws))
                    try:
                        async for raw in ws:
                            try:
                                message = json.loads(raw)
                            except json.JSONDecodeError:
                                logger.warning("Ignoring non-JSON message")
                                continue
                            await self._handle_message(ws, message)
                    finally:
                        refresh.cancel()
            except Exception as exc:  # noqa: BLE001 — reconnect loop
                logger.warning("Disconnected (%s); retry in %.1fs", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 1.7)

    async def _obs_refresh_loop(self, ws: Any) -> None:
        """Re-probe OBS so a helper started before OBS is not stuck websocket=false."""
        while True:
            await asyncio.sleep(5)
            try:
                caps = await asyncio.to_thread(self.capabilities, refresh_obs=True)
                await ws.send(json.dumps({"type": "hello", "capabilities": caps}))
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.debug("OBS capability refresh failed", exc_info=True)

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
        webcam_session = None
        obs_session = None
        job = None
        try:
            job = upload_job_from_dict(job_payload)
            job.cancel_event = cancel_event
            media_raw = (job.media_path or "").strip()
            if is_obs_openmoq_source(media_raw) or (getattr(job, "encoder", "") or "").lower() == "obs":
                job.encoder = "obs"
                moq = job.destination.moq_target
                obs_session = obs_broker.acquire(
                    job.comparison_id,
                    protocol=job.destination.protocol,
                    publish_url=job.destination.url,
                    moq_endpoint=(moq.endpoint if moq is not None else ""),
                    moq_namespace=(moq.namespace if moq is not None else ""),
                    encode_ladder=job.encode_ladder,
                    cancel_event=cancel_event,
                )
            elif media_raw.lower().startswith("device:webcam"):
                # Multi-protocol comparisons start one job per leg at once;
                # route them through the shared-capture broker so they don't
                # race to open the same physical camera (see
                # publisher_agent/webcam_broker.py). Each job still ends up
                # with a normal live media_path (a loopback UDP URL) that
                # UploadService already knows how to read.
                job.media_path, webcam_session = webcam_broker.acquire(
                    media_raw.lower(),
                    duration_sec=job.duration_sec,
                    cancel_event=cancel_event,
                )
                # job.ffmpeg_cmd was frozen at construction with the original
                # device:webcam input — without this refresh the RTMP/SRT
                # direct pipelines ignore the rewritten media_path and open
                # the camera anyway, defeating the broker entirely.
                job.dest_count = max(1, len(webcam_session.ports))
                job.refresh_ffmpeg_cmd()
                if webcam_session.direct_device:
                    logger.info(
                        "Webcam job %s single-hop (no UDP tee): %s",
                        job_id[:8],
                        job.media_path,
                    )
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

            def on_media_zero(epoch: float) -> None:
                fut = asyncio.run_coroutine_threadsafe(
                    ws.send(
                        json.dumps(
                            {"type": "media_zero", "job_id": job_id, "media_zero_epoch": float(epoch)}
                        )
                    ),
                    loop,
                )
                try:
                    fut.result(timeout=5)
                except Exception:  # noqa: BLE001
                    pass

            def on_packager_transit(transit_ms: float) -> None:
                fut = asyncio.run_coroutine_threadsafe(
                    ws.send(
                        json.dumps(
                            {
                                "type": "packager_transit",
                                "job_id": job_id,
                                "packager_transit_ms": float(transit_ms),
                            }
                        )
                    ),
                    loop,
                )
                try:
                    fut.result(timeout=5)
                except Exception:  # noqa: BLE001
                    pass

            def on_delivery_media_origin(origin_sec: float) -> None:
                fut = asyncio.run_coroutine_threadsafe(
                    ws.send(
                        json.dumps(
                            {
                                "type": "delivery_media_origin",
                                "job_id": job_id,
                                "delivery_media_origin_sec": float(origin_sec),
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
            job.on_media_zero = on_media_zero
            job.on_packager_transit = on_packager_transit
            job.on_delivery_media_origin = on_delivery_media_origin

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
                if result.error:
                    # After the webcam broker, media_path is udp:// — bare EIO
                    # is the publisher pipe, not AVFoundation exclusive-open.
                    result.error = classify_result_error(
                        result.error,
                        media_path=job.media_path,
                        original_media=media_raw,
                    )
            finally:
                os.chdir(previous_cwd)
                if webcam_session is not None:
                    webcam_broker.release(webcam_session)
                if obs_session is not None:
                    obs_broker.release(obs_session)

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
            media_raw = str((job_payload or {}).get("media_path") or "")
            encoder = str((job_payload or {}).get("encoder") or "")
            if is_obs_openmoq_source(media_raw) or encoder.lower() == "obs":
                err_text = classify_obs_error(exc)
            elif webcam_session is not None:
                # Broker already opened the camera. Job-thread EIO is pipe.
                err_text = classify_job_exception(
                    exc,
                    media_path=job.media_path if job is not None else media_raw,
                    role="ffmpeg",
                )
            else:
                err_text = classify_job_exception(
                    exc,
                    media_path=media_raw,
                    role="camera" if is_device_webcam_source(media_raw) else "job",
                )
            err = {
                "type": "job_done",
                "job_id": job_id,
                "result": {
                    "success": False,
                    "error": err_text,
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
