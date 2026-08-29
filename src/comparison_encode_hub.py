"""One x264 master per cloud comparison; legs remux with -c:v copy.

Comparison 31 spawned four libx264 jobs on the web VM (speed≈0.3×, 0 paint).
Serializing dests is not the product — a 4-way BBB must stay realtime.
File-source comparison legs therefore share one encode and copy-remux to
each protocol dest. Independent jobs still take an encode slot.
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional

from encode_profile import (
    DEFAULT_ENCODE_LADDER_ID,
    DEFAULT_TARGET_LATENCY_MS,
    build_video_encode_args,
    delivery_gop_frames,
)
from moq_publish import (
    BROWSER_COMPAT_AUDIO_ARGS,
    MPEGTS_VIDEO_BSF,
    SHARED_ENCODE_QUERY,
    find_ffmpeg,
    is_live_media_source,
    is_obs_openmoq_source,
    is_shared_encode_udp,
)

logger = logging.getLogger("MoQ-SRT-Bench")


def job_can_join_shared_encode(job) -> bool:
    """True for cloud ffmpeg file-source legs that share a comparison_id."""
    if (getattr(job, "publisher_host", "cloud") or "cloud").strip().lower() != "cloud":
        return False
    if (getattr(job, "encoder", "ffmpeg") or "ffmpeg").strip().lower() != "ffmpeg":
        return False
    if not (getattr(job, "comparison_id", "") or "").strip():
        return False
    media = getattr(job, "media_path", "") or ""
    if is_shared_encode_udp(media) or is_live_media_source(media) or is_obs_openmoq_source(media):
        return False
    return bool(media)


def shared_encode_reader_url(port: int) -> str:
    return (
        f"udp://127.0.0.1:{int(port)}"
        f"?fifo_size=1000000&overrun_nonfatal=1&{SHARED_ENCODE_QUERY}"
    )


def _pick_udp_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _session_key(job) -> str:
    cid = (getattr(job, "comparison_id", "") or "").strip()
    media = os.path.realpath(getattr(job, "media_path", "") or "")
    ladder = (getattr(job, "encode_ladder", "") or DEFAULT_ENCODE_LADDER_ID).strip().lower()
    return f"{cid}|{media}|{ladder}"


@dataclass
class _SharedSession:
    key: str
    media_path: str
    encode_ladder: str
    target_latency_ms: int
    duration_sec: int
    readers: Dict[str, int] = field(default_factory=dict)
    master: Optional[subprocess.Popen] = None
    fanout_sock: Optional[socket.socket] = None
    fanout_thread: Optional[threading.Thread] = None
    stop: threading.Event = field(default_factory=threading.Event)
    ready: threading.Event = field(default_factory=threading.Event)
    start_error: str = ""


class ComparisonEncodeHub:
    """Process-wide shared encode sessions keyed by comparison + media + ladder."""

    def __init__(
        self,
        *,
        popen: Callable[..., subprocess.Popen] = subprocess.Popen,
        find_bin: Callable[[], str] = find_ffmpeg,
    ) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, _SharedSession] = {}
        self._popen = popen
        self._find_bin = find_bin

    def attach(self, job, cancel_event: Optional[threading.Event] = None) -> str:
        """Start or join the master; return the remux UDP URL for this job."""
        token = (getattr(job, "job_id", "") or "").strip() or "unknown"
        key = _session_key(job)
        duration = max(5, int(getattr(job, "duration_sec", 0) or 60))
        with self._lock:
            session = self._sessions.get(key)
            if session is None:
                session = _SharedSession(
                    key=key,
                    media_path=getattr(job, "media_path", "") or "",
                    encode_ladder=(getattr(job, "encode_ladder", "") or DEFAULT_ENCODE_LADDER_ID),
                    target_latency_ms=int(
                        getattr(job, "target_latency_ms", 0) or DEFAULT_TARGET_LATENCY_MS
                    ),
                    duration_sec=duration,
                )
                self._sessions[key] = session
                self._start_master_locked(session)
            else:
                session.duration_sec = max(session.duration_sec, duration)
            port = session.readers.get(token) or _pick_udp_port()
            session.readers[token] = port
        if cancel_event is not None:
            while not session.ready.wait(timeout=0.2):
                if cancel_event.is_set():
                    self.detach(job)
                    raise RuntimeError("Cancelled while starting the shared comparison encode")
                if session.start_error:
                    self.detach(job)
                    raise RuntimeError(session.start_error)
        elif not session.ready.wait(timeout=20):
            self.detach(job)
            raise RuntimeError(session.start_error or "Shared comparison encode did not start")
        if session.start_error:
            self.detach(job)
            raise RuntimeError(session.start_error)
        return shared_encode_reader_url(session.readers[token])

    def detach(self, job) -> None:
        token = (getattr(job, "job_id", "") or "").strip() or "unknown"
        session = None
        with self._lock:
            for key, candidate in list(self._sessions.items()):
                if token not in candidate.readers:
                    continue
                candidate.readers.pop(token, None)
                if candidate.readers:
                    return
                session = self._sessions.pop(key, None)
                break
        if session is not None:
            self._stop_master(session)

    def reader_count(self, job) -> int:
        token = (getattr(job, "job_id", "") or "").strip() or "unknown"
        with self._lock:
            for session in self._sessions.values():
                if token in session.readers:
                    return len(session.readers)
            return 0

    def _start_master_locked(self, session: _SharedSession) -> None:
        cmd = self._master_cmd(session)
        try:
            session.master = self._popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
        except OSError as exc:
            session.start_error = f"Failed to start shared comparison encode: {exc}"
            session.ready.set()
            return
        session.fanout_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        session.fanout_thread = threading.Thread(
            target=self._fanout,
            args=(session,),
            name=f"shared-encode-{session.key[:12]}",
            daemon=True,
        )
        session.fanout_thread.start()
        session.ready.set()

    def _master_cmd(self, session: _SharedSession) -> list[str]:
        video = build_video_encode_args(
            session.encode_ladder,
            session.target_latency_ms,
            gop_frames=delivery_gop_frames(session.target_latency_ms),
        )
        return [
            self._find_bin(),
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            "-i",
            session.media_path,
            "-t",
            str(session.duration_sec),
            *video,
            *BROWSER_COMPAT_AUDIO_ARGS,
            "-bsf:v",
            MPEGTS_VIDEO_BSF,
            "-f",
            "mpegts",
            "pipe:1",
        ]

    def _fanout(self, session: _SharedSession) -> None:
        stdout = session.master.stdout if session.master is not None else None
        sock = session.fanout_sock
        if stdout is None or sock is None:
            return
        try:
            while not session.stop.is_set():
                chunk = stdout.read(188 * 32)
                if not chunk:
                    break
                with self._lock:
                    ports = list(session.readers.values())
                for port in ports:
                    try:
                        sock.sendto(chunk, ("127.0.0.1", port))
                    except OSError:
                        continue
        finally:
            try:
                stdout.close()
            except OSError:
                pass

    def _stop_master(self, session: _SharedSession) -> None:
        session.stop.set()
        proc = session.master
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)
        if session.fanout_thread is not None:
            session.fanout_thread.join(timeout=2)
        if session.fanout_sock is not None:
            try:
                session.fanout_sock.close()
            except OSError:
                pass


_HUB = ComparisonEncodeHub()


def attach_shared_encode(job, cancel_event: Optional[threading.Event] = None) -> str:
    return _HUB.attach(job, cancel_event)


def release_shared_encode(job) -> None:
    _HUB.detach(job)
