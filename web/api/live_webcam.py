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

    def start_bridge(self) -> None:
        if self._proc is not None:
            return
        ffmpeg = find_ffmpeg()
        tee_targets = "|".join(
            f"[f=mpegts:onfail=ignore]udp://127.0.0.1:{port}?pkt_size=1316"
            for port in self.ports
        )
        cmd = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "warning",
            "-fflags",
            "+genpts+discardcorrupt",
            "-f",
            "webm",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
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
            "-c:a",
            "aac",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-f",
            "tee",
            tee_targets,
        ]
        logger.info("Starting live webcam bridge session=%s cmd=%s", self.id, " ".join(cmd))
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        def _watch_stderr() -> None:
            assert self._proc is not None and self._proc.stderr is not None
            for line in iter(self._proc.stderr.readline, b""):
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    logger.warning("live-bridge[%s]: %s", self.id, text)
            code = self._proc.poll()
            if code not in (None, 0) and not self._closed:
                self.failed = f"live bridge ffmpeg exited with code {code}"
                self.ready.set()

        threading.Thread(target=_watch_stderr, name=f"live-bridge-{self.id}", daemon=True).start()

    def write(self, chunk: bytes) -> None:
        if self._closed or not chunk:
            return
        if self._proc is None:
            self.start_bridge()
        assert self._proc is not None and self._proc.stdin is not None
        with self._stdin_lock:
            if self._closed:
                return
            try:
                self._proc.stdin.write(chunk)
                self._proc.stdin.flush()
            except BrokenPipeError as exc:
                self.failed = f"live bridge pipe broken: {exc}"
                self.ready.set()
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
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        self._proc = None


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
