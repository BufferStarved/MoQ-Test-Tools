"""Live webcam bridge: browser MediaRecorder WebM → ffmpeg → local MPEG-TS UDP.

Each comparison stream gets its own UDP URL so independent ffmpeg publish jobs can
read the same live camera feed without opening the device twice.
"""

from __future__ import annotations

import logging
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from moq_publish import find_ffmpeg  # noqa: E402

logger = logging.getLogger("MoQ-LiveWebcam")

# Max live webcam run length (user can stop earlier from the UI).
DEFAULT_LIVE_DURATION_SEC = 300
MAX_LIVE_DURATION_SEC = 300
_UDP_PORT_BASE = 19000


@dataclass
class LiveWebcamSession:
    id: str
    duration_sec: int
    media_paths: List[str]
    ports: List[int]
    created_at: float = field(default_factory=time.time)
    ready: threading.Event = field(default_factory=threading.Event)
    failed: Optional[str] = None
    _proc: Optional[subprocess.Popen] = None
    _stdin_lock: threading.Lock = field(default_factory=threading.Lock)
    _bytes_in: int = 0
    _closed: bool = False
    _ready_notified: bool = False
    # Latest ffmpeg -progress out_time (ms, includes -output_ts_offset so it
    # stays continuous across restarts). Used for bridge_lag_ms.
    _out_time_ms: float = 0.0

    @property
    def bridge_lag_ms(self) -> float:
        """Capture-to-bridge-output delay estimate (ms).

        The bridge timeline is wall-anchored at session creation (CFR output +
        restart ts_offset = elapsed wall time), so wall-elapsed minus emitted
        media duration is how far the whole browser->WS->bridge chain lags
        realtime. This is the shared upstream blind spot of every per-protocol
        latency estimate — without it, SRT's PDT figure and RTMP's encoder-
        anchored figure both under-report true glass-to-glass by this amount.
        """
        if self._out_time_ms <= 0:
            return 0.0
        elapsed_ms = max(0.0, (time.time() - self.created_at) * 1000.0)
        return max(0.0, elapsed_ms - self._out_time_ms)

    def start_bridge(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        # Prior process may have exited on a truncated WebM cluster — clear and restart.
        self._proc = None
        ffmpeg = find_ffmpeg()
        tee_targets = "|".join(
            f"[f=mpegts:onfail=ignore]udp://127.0.0.1:{port}?pkt_size=1316"
            for port in self.ports
        )
        # A restart starts a brand-new ffmpeg with PTS at ~0, but the downstream
        # per-destination SRT/RTMP/MoQ encoders are still reading the same UDP
        # ports mid-stream. A sudden PTS rewind there breaks HLS.js's MSE
        # SourceBuffer append (bufferAppendError) and shows up as SRT segment
        # churn. Keep this restart's timeline above where the session already
        # is, mirroring the Zixi Fast HLS -output_ts_offset trick.
        offset_sec = max(0.0, time.time() - self.created_at)
        offset_args: List[str] = []
        if offset_sec > 0.5:
            offset_args = ["-output_ts_offset", f"{offset_sec:.3f}"]
        cmd = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-fflags",
            "+genpts+discardcorrupt+igndts",
            "-err_detect",
            "ignore_err",
            # Chrome's MediaRecorder periodically starts a fresh WebM header
            # mid-stream (observed at a consistent ~17.5MB), which EOFs this
            # demuxer and triggers the restart path below. With default probe
            # settings the NEW ffmpeg buffered up to ~5s of input before
            # producing anything — a multi-second hole in every downstream
            # protocol (SRT sawtooth lag, MoQ delivery starvation, 2026-07-22).
            # The input is always Chrome WebM (VP8/VP9 + Opus); a tiny probe
            # is safe and makes restarts near-seamless.
            "-probesize",
            "64k",
            "-analyzeduration",
            "500000",
            "-f",
            "webm",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            "fps=30",
            "-fps_mode",
            "cfr",
            "-r",
            "30",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-tune",
            "zerolatency",
            "-pix_fmt",
            "yuv420p",
            "-g",
            "30",
            "-keyint_min",
            "30",
            "-bf",
            "0",
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            *offset_args,
            "-progress",
            "pipe:1",
            "-nostats",
            "-f",
            "tee",
            tee_targets,
        ]
        logger.info("Starting live webcam bridge session=%s cmd=%s", self.id, " ".join(cmd))
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        def _watch_progress(proc: subprocess.Popen) -> None:
            if proc.stdout is None:
                return
            try:
                for line in iter(proc.stdout.readline, b""):
                    text = line.decode("utf-8", errors="replace").strip()
                    if text.startswith("out_time_us="):
                        try:
                            self._out_time_ms = int(text.split("=", 1)[1]) / 1000.0
                        except ValueError:
                            continue
            except (ValueError, OSError):
                return

        threading.Thread(
            target=_watch_progress,
            args=(self._proc,),
            name=f"live-bridge-progress-{self.id}",
            daemon=True,
        ).start()

        def _watch_stderr() -> None:
            proc = self._proc
            if proc is None or proc.stderr is None:
                return
            try:
                for line in iter(proc.stderr.readline, b""):
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if text:
                        logger.warning("live-bridge[%s]: %s", self.id, text)
            except (ValueError, OSError):
                # stderr closed while session teardown races this watcher.
                return
            code = proc.poll()
            # Ignore exit if a newer bridge replaced this process (restart on truncated WebM).
            if code not in (None, 0) and not self._closed and self._proc is proc:
                self.failed = f"live bridge ffmpeg exited with code {code}"
                self.ready.set()

        threading.Thread(target=_watch_stderr, name=f"live-bridge-{self.id}", daemon=True).start()

    def write(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return
        with self._stdin_lock:
            if self._closed:
                return
            proc = self._proc
            if proc is None or proc.poll() is not None:
                # MediaRecorder WebM often ends a cluster abruptly; restart ffmpeg
                # instead of failing the whole live session.
                if proc is not None:
                    logger.warning(
                        "live-bridge[%s]: ffmpeg exited (code=%s); restarting",
                        self.id,
                        proc.poll(),
                    )
                    self._proc = None
                    self.failed = None
                self.start_bridge()
                proc = self._proc
            if proc is None or proc.stdin is None:
                return
            try:
                proc.stdin.write(chunk)
                proc.stdin.flush()
            except BrokenPipeError:
                logger.warning("live-bridge[%s]: broken pipe; will restart on next chunk", self.id)
                try:
                    proc.kill()
                except OSError:
                    pass
                self._proc = None
                return
        self._bytes_in += len(chunk)
        # After a small amount of media, fans-out are producing — jobs can start.
        if self._bytes_in >= 32_000:
            self.ready.set()

    def close(self) -> None:
        self._closed = True
        self.ready.set()
        proc = self._proc
        if proc is None:
            return
        try:
            if proc.stdin:
                with self._stdin_lock:
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except OSError:
                pass
        # Keep _proc until stderr watcher finishes reading; nulling early caused
        # AttributeError: 'NoneType'.poll in the watcher thread.


class LiveWebcamManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, LiveWebcamSession] = {}
        self._next_port = _UDP_PORT_BASE

    def create(self, stream_count: int, duration_sec: int = DEFAULT_LIVE_DURATION_SEC) -> LiveWebcamSession:
        if stream_count < 1 or stream_count > 9:
            raise ValueError("stream_count must be between 1 and 9")
        duration_sec = max(5, min(MAX_LIVE_DURATION_SEC, int(duration_sec)))
        with self._lock:
            ports = list(range(self._next_port, self._next_port + stream_count))
            self._next_port += stream_count
            session_id = str(uuid.uuid4())
            media_paths = [f"udp://127.0.0.1:{port}?fifo_size=1000000&overrun_nonfatal=1" for port in ports]
            session = LiveWebcamSession(
                id=session_id,
                duration_sec=duration_sec,
                media_paths=media_paths,
                ports=ports,
            )
            self._sessions[session_id] = session
            return session

    def get(self, session_id: str) -> Optional[LiveWebcamSession]:
        with self._lock:
            return self._sessions.get(session_id)

    def close(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            session.close()


live_webcam_manager = LiveWebcamManager()
