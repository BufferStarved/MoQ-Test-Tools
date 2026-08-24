"""Shares one physical webcam capture across concurrent local-publisher jobs.

Incident (2026-08-05): a live webcam comparison with SRT + MoQ + RTMP legs
lost SRT and MoQ every time, both failing within the same second as job
creation with the identical error: ``ffmpeg exited with code 251: Error
opening input files: Input/output error``. Only the RTMP leg (whichever
ffmpeg happened to win the race) survived.

Root cause: since ``b75985e`` (Replace browser webcam bridge with a local
publisher agent), each protocol leg is an independent job that opens
``device:webcam`` itself (see ``moq_publish.build_device_webcam_input_args``).
The UI fires one job per leg back-to-back for a multi-way comparison (see
``web/frontend/src/App.tsx``'s ``Promise.all`` over ``createUpload``), so N
ffmpeg processes race to open the same AVFoundation/V4L2 device at once.
Those devices only tolerate one reader — the loser(s) exit immediately.

This mirrors what the *old*, now-deleted browser bridge already solved: it
opened the camera exactly once and handed each comparison leg its own UDP
URL to read from (see the "Webcam bridge -> UDP" PTS-regeneration comment
still in ``moq_publish.is_live_media_source`` / ``build_ffmpeg_input_args`` —
that special-casing was written for exactly this shape of input and never
removed). This module reintroduces that behavior at the agent layer: open
the device once, re-encode to a normalized H.264/AAC feed, and fan it out
over loopback UDP (ffmpeg's ``tee`` muxer) — one port per sibling job. Each
job's own ``UploadService`` pipeline then treats
``udp://127.0.0.1:<port>`` like any other live network source. One caveat:
``UploadJob`` freezes its ffmpeg command at construction, so after swapping
``job.media_path`` for the brokered URL the agent must call
``job.refresh_ffmpeg_cmd()`` — otherwise RTMP/WHIP legs keep the original
device-capture input and open the camera directly anyway (2026-08-06).
"""

from __future__ import annotations

import logging
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple  # noqa: I001 — Tuple used by mode fallback

import sys

ROOT_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from avfoundation_modes import (  # noqa: E402
    PREFERRED_FPS,
    VIRTUAL_CAM_FALLBACK_FPS,
    VIRTUAL_CAM_FALLBACK_SIZE,
    avfoundation_input_hints,
    parse_avfoundation_supported_modes,
    pick_avfoundation_mode,
)
from encode_profile import ASSUMED_FPS  # noqa: E402
from moq_publish import (  # noqa: E402
    BROWSER_COMPAT_AUDIO_ARGS,
    CAMERA_EIO_HINT,
    build_device_webcam_input_args,
    classify_job_exception,
    classify_spawn_oserror,
    device_webcam_index,
    find_ffmpeg,
)

logger = logging.getLogger("publisher-agent.webcam-broker")

# Sibling jobs from one "start comparison" click land within milliseconds of
# each other locally, but each is its own POST /api/uploads round trip over
# the real internet to the hosted API (see JobManager.create_job spawning an
# independent thread per job), so give real-world jitter more headroom than a
# same-host dev loop needs. This window batches them into a single physical
# camera open before the shared capture starts; late arrivals (after the
# window closes) fall back to opening the device themselves, same as today.
JOIN_WINDOW_SEC = 1.0
# How long to wait, after starting ffmpeg, for it to prove it didn't die
# immediately (bad device index, camera permission denied, device busy).
# 2026-08-06 incident: a tee-muxer misconfiguration killed the master ~1.0s
# in — just past the previous 0.75s window — so acquire() reported success
# and every leg starved on a UDP feed nothing ever fed. Keep this above the
# observed fast-failure modes; _check_early_exit polls so genuine failures
# still surface as fast as they happen.
STARTUP_CHECK_SEC = 2.0
ACQUIRE_TIMEOUT_SEC = JOIN_WINDOW_SEC + STARTUP_CHECK_SEC + 10.0
# Safety ceiling so a stuck shared capture can't outlive every subscriber
# forever if refcounting ever gets out of sync.
MASTER_HARD_CAP_SEC = 15 * 60
# High enough that every existing encode ladder (see encode_profile.py,
# 1080p tops out at 5250/6000) re-encodes *down* from this, never up.
MASTER_BITRATE_KBPS = 5250
MASTER_MAXRATE_KBPS = 6000
# 1s GOP on the shared capture. Brokered MoQ *copies* this bitstream —
# there is no 0.5s child re-encode (that comment was stale; a second x264
# on the UDP hop still ran 24↔37 fps). A 0.5s master plus two siblings
# dropped encode to ~24fps / 0.8× (CSV 2026-08-20). Solo webcam MoQ skips
# the broker and uses moq_gop_frames_for_latency (~0.25s) in moq_publish.
MASTER_GOP_FRAMES = ASSUMED_FPS
# Some MacBook cameras default to a *portrait* native AVFoundation capture
# mode (e.g. 1080x1920) when no size is requested — confirmed 2026-08-06 on
# a MacBook Pro built-in camera, with no rotation metadata to correct it.
# Request landscape explicitly; build_device_webcam_input_args()'s docstring
# notes forcing one fixed size has previously failed on some Macs, so this
# is a preference we retry away from (see _start_after_join_window), not an
# unconditional requirement.
PREFERRED_LANDSCAPE_VIDEO_SIZE = "1280x720"
PREFERRED_LANDSCAPE_FPS = "30"


def _pick_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@dataclass
class _Session:
    key: str
    lock: threading.Lock = field(default_factory=threading.Lock)
    ready: threading.Event = field(default_factory=threading.Event)
    ports: List[int] = field(default_factory=list)
    process: Optional[subprocess.Popen] = None
    error: Optional[str] = None
    refcount: int = 0
    started: bool = False
    # One job: keep device:webcam so MoQ encodes camera → CMAF (no UDP hop).
    # Two+ jobs: fan out over UDP so siblings do not race the camera.
    share_policy: str = "auto"
    source_media: str = ""
    direct_device: bool = False


class WebcamBroker:
    """Fans one ``device:webcam`` capture out to N loopback UDP feeds."""

    def __init__(self) -> None:
        self._sessions: Dict[str, _Session] = {}
        self._sessions_lock = threading.Lock()

    def acquire(
        self,
        media_path: str,
        *,
        duration_sec: Optional[int] = None,
        cancel_event: Optional[threading.Event] = None,
        share_policy: str = "auto",
    ) -> Tuple[str, _Session]:
        """Register as a subscriber of the shared capture for ``media_path``.

        Blocks briefly while sibling requests are collected. One subscriber
        keeps ``device:webcam`` (camera → that job's ffmpeg). Two or more
        get ``udp://127.0.0.1:<port>`` from a shared tee. ``share_policy=
        "always"`` forces the tee (tests / multi-protocol).
        Call :meth:`release` with the returned session exactly once, even on
        failure, to avoid leaking the shared capture process.
        """
        key = media_path.strip().lower()
        with self._sessions_lock:
            session = self._sessions.get(key)
            if session is None or session.started:
                session = _Session(key=key, share_policy=share_policy, source_media=media_path)
                self._sessions[key] = session
                threading.Thread(
                    target=self._start_after_join_window,
                    args=(session, media_path, duration_sec),
                    daemon=True,
                    name="webcam-broker-start",
                ).start()
            port = _pick_udp_port()
            session.ports.append(port)
            session.refcount += 1

        try:
            deadline = time.monotonic() + ACQUIRE_TIMEOUT_SEC
            while not session.ready.is_set():
                if cancel_event is not None and cancel_event.is_set():
                    raise RuntimeError("Cancelled while waiting for shared webcam capture")
                if time.monotonic() > deadline:
                    raise RuntimeError("Timed out starting shared webcam capture")
                session.ready.wait(timeout=0.2)
            if session.error:
                raise RuntimeError(session.error)
        except Exception:
            self.release(session)
            raise

        if session.direct_device:
            logger.info(
                "Single webcam job: skip UDP broker; camera → this job's ffmpeg"
            )
            return session.source_media or media_path, session
        return f"udp://127.0.0.1:{port}?timeout=15000000&fifo_size=1000000", session

    def release(self, session: _Session) -> None:
        should_stop = False
        with self._sessions_lock:
            session.refcount -= 1
            if session.refcount <= 0:
                should_stop = True
                if self._sessions.get(session.key) is session:
                    self._sessions.pop(session.key, None)
        if should_stop:
            self._terminate(session)

    def _start_after_join_window(
        self, session: _Session, media_path: str, duration_sec: Optional[int]
    ) -> None:
        time.sleep(JOIN_WINDOW_SEC)
        with session.lock:
            if session.started:
                return
            session.started = True
            ports = list(session.ports)
            if session.share_policy != "always" and len(ports) == 1:
                session.direct_device = True
                logger.info(
                    "Single webcam subscriber after join window — no shared tee"
                )
            else:
                try:
                    self._start_capture_with_mode_fallback(session, media_path, ports)
                except Exception as exc:  # noqa: BLE001 — surfaced to acquire() callers
                    session.error = classify_job_exception(
                        exc, media_path=media_path, role="camera"
                    )
        session.ready.set()

    def _start_capture_with_mode_fallback(
        self, session: _Session, media_path: str, ports: List[int]
    ) -> None:
        """Open the camera without assuming 720p30 — OBS Virtual Cam is 1080p60.

        Retry order: preferred landscape → device-advertised mode from the
        251 stderr dump → omit rigid -r/-s so avfoundation negotiates →
        1080p60 virtual-cam last resort. One device that cannot do 30p720
        must not fail the whole comparison.
        """
        attempts: List[Tuple[Optional[str], Optional[str], str]] = [
            (PREFERRED_LANDSCAPE_VIDEO_SIZE, PREFERRED_LANDSCAPE_FPS, "preferred 720p30"),
        ]
        last_error = ""
        tried: set[Tuple[Optional[str], Optional[str]]] = set()

        for video_size, framerate, label in attempts:
            key = (video_size, framerate)
            if key in tried:
                continue
            tried.add(key)
            session.error = None
            session.process = self._spawn_capture(
                media_path, ports, video_size=video_size, framerate=framerate
            )
            self._check_early_exit(session)
            if session.error is None:
                return
            last_error = session.error
            logger.warning("Shared webcam capture %s failed (%s)", label, session.error)

            modes = parse_avfoundation_supported_modes(session.error)
            picked = pick_avfoundation_mode(modes, prefer_fps=PREFERRED_FPS)
            if picked is not None:
                size, fps = avfoundation_input_hints(picked)
                extra = (size, fps, f"probed {picked.size}@{picked.native_fps:g}")
                if (extra[0], extra[1]) not in tried:
                    attempts.append(extra)

        # Let avfoundation pick its native mode (no -framerate / -video_size).
        if (None, None) not in tried:
            session.error = None
            session.process = self._spawn_capture(
                media_path, ports, video_size=None, framerate=None
            )
            self._check_early_exit(session)
            if session.error is None:
                return
            last_error = session.error
            logger.warning(
                "Shared webcam capture with negotiated format failed (%s)", session.error
            )
            modes = parse_avfoundation_supported_modes(session.error)
            picked = pick_avfoundation_mode(modes, prefer_fps=VIRTUAL_CAM_FALLBACK_FPS)
            if picked is not None:
                size, fps = avfoundation_input_hints(picked)
                session.error = None
                session.process = self._spawn_capture(
                    media_path, ports, video_size=size, framerate=fps
                )
                self._check_early_exit(session)
                if session.error is None:
                    return
                last_error = session.error

        # Last resort: typical OBS Virtual Camera mode.
        session.error = None
        session.process = self._spawn_capture(
            media_path,
            ports,
            video_size=VIRTUAL_CAM_FALLBACK_SIZE,
            framerate=str(int(VIRTUAL_CAM_FALLBACK_FPS)),
        )
        self._check_early_exit(session)
        if session.error is None:
            return
        session.error = last_error or session.error

    def _spawn_capture(
        self,
        media_path: str,
        ports: List[int],
        *,
        video_size: Optional[str],
        framerate: Optional[str] = "30",
    ) -> subprocess.Popen:
        input_args = build_device_webcam_input_args(
            duration_sec=MASTER_HARD_CAP_SEC,
            device_index=device_webcam_index(media_path),
            video_size=video_size,
            framerate=framerate,
        )
        # ffmpeg's tee muxer cannot auto-select streams: without explicit
        # -map it opens with zero streams and exits ~1s in ("Output file
        # does not contain any stream", code 234) — which is exactly how the
        # 2026-08-06 webcam comparison starved every leg reading the broker
        # feed. The Linux V4L2 path already carries its own maps (camera +
        # anullsrc are separate inputs); only add ours when absent.
        map_args: List[str] = []
        if "-map" not in input_args:
            map_args = ["-map", "0:v:0", "-map", "0:a:0?"]
        tee_targets = "|".join(
            f"[f=mpegts]udp://127.0.0.1:{port}?pkt_size=1316" for port in ports
        )
        cmd = [
            find_ffmpeg(),
            "-hide_banner",
            "-loglevel",
            "warning",
            *input_args,
            *map_args,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-profile:v",
            "main",
            "-level:v",
            "4.0",
            "-g",
            str(MASTER_GOP_FRAMES),
            "-keyint_min",
            str(MASTER_GOP_FRAMES),
            "-sc_threshold",
            "0",
            "-b:v",
            f"{MASTER_BITRATE_KBPS}k",
            "-maxrate",
            f"{MASTER_MAXRATE_KBPS}k",
            "-bufsize",
            f"{MASTER_MAXRATE_KBPS}k",
            "-x264-params",
            "repeat-headers=1",
            *BROWSER_COMPAT_AUDIO_ARGS,
            "-f",
            "tee",
            tee_targets,
        ]
        logger.info(
            "Starting shared webcam capture for %d sibling job(s): %s",
            len(ports),
            " ".join(cmd),
        )
        try:
            return subprocess.Popen(
                cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True
            )
        except OSError as exc:
            raise RuntimeError(
                classify_spawn_oserror(
                    exc,
                    role="camera",
                    binary=cmd[0] if cmd else "",
                    media_path=media_path,
                )
            ) from exc

    def _check_early_exit(self, session: _Session) -> None:
        # Give ffmpeg a moment to fail fast (bad device index, permission
        # denied, device already exclusively held) before handing out UDP
        # URLs nobody will ever feed. Poll instead of one fixed sleep so a
        # death anywhere in the window is caught without penalizing the
        # failure path with the full wait.
        process = session.process
        if process is None:
            return
        deadline = time.monotonic() + STARTUP_CHECK_SEC
        while time.monotonic() < deadline and process.poll() is None:
            time.sleep(0.1)
        if process.poll() is not None:
            stderr = ""
            try:
                if process.stderr is not None:
                    stderr = (process.stderr.read() or "")[-2000:]
            except Exception:  # noqa: BLE001
                pass
            detail = stderr.strip() or "unknown error"
            if "Input/output error" in detail:
                session.error = (
                    f"camera I/O error: Shared webcam capture exited immediately "
                    f"(code {process.returncode}): {detail}. {CAMERA_EIO_HINT}"
                )
            else:
                session.error = (
                    f"Shared webcam capture exited immediately (code {process.returncode}): "
                    f"{detail}"
                )

    def _terminate(self, session: _Session) -> None:
        process = session.process
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        if process.stderr is not None:
            try:
                process.stderr.close()
            except Exception:  # noqa: BLE001
                pass
        logger.info(
            "Stopped shared webcam capture (%d subscriber port(s))", len(session.ports)
        )


webcam_broker = WebcamBroker()
