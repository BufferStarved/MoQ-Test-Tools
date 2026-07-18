"""Poll MediaMTX Prometheus metrics / API and map onto the bench metric model.

MediaMTX co-located on moq-web exposes:
  http://127.0.0.1:9998/metrics   (Prometheus)
  http://127.0.0.1:9997/v3/...    (REST)

SRT conn metrics are nearly 1:1 with libsrt (RTT, loss, retrans, rates).
Path byte counters cover RTMP/WHIP ingest when SRT labels are absent.
"""

from __future__ import annotations

import logging
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote_plus, urlparse

logger = logging.getLogger("MoQ-SRT-Bench")

DEFAULT_METRICS_URL = "http://127.0.0.1:9998/metrics"
DEFAULT_API_URL = "http://127.0.0.1:9997"
DEFAULT_PATH = "benchmark"

_LINE_RE = re.compile(
    r"^([a-zA-Z_:][a-zA-Z0-9_:]*)"
    r"(?:\{([^}]*)\})?"
    r"\s+([-+0-9.eE]+|NaN|Inf)\s*$"
)
_LABEL_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"])*)"')


@dataclass
class MediaMtxStatsSnapshot:
    """Receiver-side snapshot mapped to existing UploadSample / MetricsCollector fields."""

    path: str = ""
    ready: bool = False
    readers: int = 0
    # Normalized transport
    net_rtt_ms: float = 0.0
    net_jitter_ms: float = 0.0
    net_send_mbps: float = 0.0  # MediaMTX → readers (egress)
    net_recv_mbps: float = 0.0  # publisher → MediaMTX (ingest)
    net_loss_pct: float = 0.0
    net_retrans_pct: float = 0.0
    # Packet counters (SRT)
    pkt_rcv_drop: int = 0
    pkt_snd_drop: int = 0
    pkt_snd_loss: int = 0
    pkt_retrans: int = 0
    # Closest stand-in for Zixi TR101 CC errors
    ts_continuity_counter_errors: int = 0
    # Raw totals (for debugging / summary)
    bytes_received: int = 0
    bytes_sent: int = 0
    srt_packets_received: int = 0
    srt_packets_received_loss: int = 0
    srt_packets_retrans: int = 0


@dataclass
class _ByteSample:
    at: float
    bytes_received: int
    bytes_sent: int


class MediaMtxStatsPoller:
    """Optional MediaMTX receiver stats for gcp_mediamtx destinations.

    Configure with:
      MEDIAMTX_METRICS_URL  default http://127.0.0.1:9998/metrics
      MEDIAMTX_API_URL      default http://127.0.0.1:9997
      MEDIAMTX_PATH         default benchmark (or derived from publish URL)
    """

    def __init__(self, endpoint_url: str = "", path: str = ""):
        self._metrics_url = (
            os.environ.get("MEDIAMTX_METRICS_URL", "").strip() or DEFAULT_METRICS_URL
        )
        self._api_url = (os.environ.get("MEDIAMTX_API_URL", "").strip() or DEFAULT_API_URL).rstrip(
            "/"
        )
        env_path = os.environ.get("MEDIAMTX_PATH", "").strip()
        self._path = (path or env_path or self._path_from_url(endpoint_url) or DEFAULT_PATH).strip(
            "/"
        )
        self._latest = MediaMtxStatsSnapshot(path=self._path)
        self._enabled = True
        self._prev_bytes: Optional[_ByteSample] = None
        self._prev_rtt_ms: float = 0.0
        self._jitter_ms: float = 0.0

        # If publish target is remote and metrics stay on loopback, still enable —
        # production encode runs on the MediaMTX host. Override URL for remote.
        host = urlparse(endpoint_url).hostname if endpoint_url else None
        if host and host not in {"127.0.0.1", "localhost"} and "127.0.0.1" in self._metrics_url:
            # Prefer localhost when co-located (moq-web). Allow explicit remote metrics.
            remote = os.environ.get("MEDIAMTX_REMOTE_METRICS", "").strip().lower()
            if remote in {"1", "true", "yes"}:
                self._metrics_url = f"http://{host}:9998/metrics"
                self._api_url = f"http://{host}:9997"

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def path(self) -> str:
        return self._path

    @staticmethod
    def _path_from_url(endpoint_url: str) -> str:
        if not endpoint_url:
            return ""
        parsed = urlparse(endpoint_url)
        if parsed.scheme == "srt":
            query = parse_qs(parsed.query)
            streamid = (query.get("streamid") or [""])[0]
            if not streamid:
                match = re.search(r"streamid=([^&]+)", endpoint_url, flags=re.IGNORECASE)
                if match:
                    streamid = match.group(1)
            streamid = unquote_plus(streamid) if "%" in streamid else streamid
            if streamid.startswith("publish:"):
                return streamid.split(":", 1)[1] or DEFAULT_PATH
            return streamid or DEFAULT_PATH
        if parsed.scheme == "rtmp":
            parts = [p for p in parsed.path.split("/") if p]
            return parts[-1] if parts else DEFAULT_PATH
        if parsed.scheme in {"http", "https"}:
            parts = [p for p in parsed.path.split("/") if p]
            # /benchmark/whip or /benchmark/whep
            if parts:
                return parts[0]
        return DEFAULT_PATH

    def poll(self) -> MediaMtxStatsSnapshot:
        if not self._enabled:
            return self._latest

        body = self._fetch(self._metrics_url)
        if body is None:
            return self._latest

        snap = self._snapshot_from_prometheus(body)
        api_ready = self._fetch_path_ready()
        if api_ready is not None:
            snap.ready = api_ready

        self._latest = snap
        return snap

    def _fetch_path_ready(self) -> Optional[bool]:
        url = f"{self._api_url}/v3/paths/get/{self._path}"
        raw = self._fetch(url)
        if raw is None:
            return None
        try:
            import json

            data = json.loads(raw)
            if isinstance(data, dict) and "ready" in data:
                return bool(data.get("ready"))
        except (ValueError, TypeError):
            return None
        return None

    def _snapshot_from_prometheus(self, body: str) -> MediaMtxStatsSnapshot:
        path = self._path
        snap = MediaMtxStatsSnapshot(path=path)

        # Path-level
        snap.bytes_received = int(
            self._metric_value(body, "paths_bytes_received", path=path)
            or self._metric_value(body, "paths_inbound_bytes", path=path)
        )
        snap.bytes_sent = int(
            self._metric_value(body, "paths_bytes_sent", path=path)
            or self._metric_value(body, "paths_outbound_bytes", path=path)
        )
        snap.readers = int(self._metric_value(body, "paths_readers", path=path))
        path_state = self._metric_label_value(body, "paths", "state", path=path)
        snap.ready = path_state == "ready" if path_state else snap.bytes_received > 0

        frames_err = int(
            self._metric_value(body, "paths_inbound_frames_in_error", path=path)
            or self._metric_value(body, "rtsp_sessions_rtp_packets_in_error", path=path)
        )
        snap.ts_continuity_counter_errors = frames_err

        # SRT conn metrics (filter by path label when present)
        snap.net_rtt_ms = self._metric_value(body, "srt_conns_ms_rtt", path=path)
        if snap.net_rtt_ms > 0:
            if self._prev_rtt_ms > 0:
                delta = abs(snap.net_rtt_ms - self._prev_rtt_ms)
                # EMA of absolute successive RTT deltas (same idea as PathRttProbe).
                self._jitter_ms = (0.7 * self._jitter_ms) + (0.3 * delta) if self._jitter_ms else delta
            self._prev_rtt_ms = snap.net_rtt_ms
            snap.net_jitter_ms = self._jitter_ms

        # Older MediaMTX builds expose mbps_* gauges; newer ones expect byte deltas.
        snap.net_recv_mbps = self._metric_value(body, "srt_conns_mbps_receive_rate", path=path)
        snap.net_send_mbps = self._metric_value(body, "srt_conns_mbps_send_rate", path=path)

        snap.srt_packets_received = int(
            self._metric_value(body, "srt_conns_packets_received", path=path)
        )
        snap.srt_packets_received_loss = int(
            self._metric_value(body, "srt_conns_packets_received_loss", path=path)
        )
        snap.srt_packets_retrans = int(
            self._metric_value(body, "srt_conns_packets_retrans", path=path)
            + self._metric_value(body, "srt_conns_packets_received_retrans", path=path)
        )
        snap.pkt_retrans = snap.srt_packets_retrans
        snap.pkt_rcv_drop = int(
            self._metric_value(body, "srt_conns_packets_received_drop", path=path)
        )
        snap.pkt_snd_drop = int(self._metric_value(body, "srt_conns_packets_send_drop", path=path))
        snap.pkt_snd_loss = int(self._metric_value(body, "srt_conns_packets_send_loss", path=path))

        # Prefer counter-derived loss %. libsrt Packet*LossRate is already percent.
        if snap.srt_packets_received > 0 and snap.srt_packets_received_loss > 0:
            snap.net_loss_pct = min(
                100.0,
                (snap.srt_packets_received_loss / max(1, snap.srt_packets_received)) * 100.0,
            )
        else:
            recv_loss_rate = self._metric_value(
                body, "srt_conns_packets_received_loss_rate", path=path
            )
            send_loss_rate = self._metric_value(
                body, "srt_conns_packets_send_loss_rate", path=path
            )
            snap.net_loss_pct = max(recv_loss_rate, send_loss_rate)

        if snap.srt_packets_received > 0 and snap.pkt_retrans > 0:
            snap.net_retrans_pct = min(
                100.0, (snap.pkt_retrans / max(1, snap.srt_packets_received)) * 100.0
            )

        # Prefer SRT/RTMP/WebRTC byte totals when path counters are empty.
        if snap.bytes_received <= 0:
            snap.bytes_received = int(
                self._metric_value(body, "srt_conns_bytes_received", path=path)
                or self._metric_value(body, "rtmp_conns_bytes_received", path=path)
                or self._metric_value(body, "webrtc_sessions_bytes_received", path=path)
            )
        if snap.bytes_sent <= 0:
            snap.bytes_sent = int(
                self._metric_value(body, "srt_conns_bytes_sent", path=path)
                or self._metric_value(body, "rtmp_conns_bytes_sent", path=path)
                or self._metric_value(body, "webrtc_sessions_bytes_sent", path=path)
            )

        # Derive Mbps from byte counters when gauges are absent (RTMP/WHIP / new MediaMTX).
        now = time.time()
        if self._prev_bytes is not None:
            dt = max(0.001, now - self._prev_bytes.at)
            d_recv = max(0, snap.bytes_received - self._prev_bytes.bytes_received)
            d_sent = max(0, snap.bytes_sent - self._prev_bytes.bytes_sent)
            derived_recv = (d_recv * 8.0) / dt / 1_000_000.0
            derived_sent = (d_sent * 8.0) / dt / 1_000_000.0
            if snap.net_recv_mbps <= 0:
                snap.net_recv_mbps = derived_recv
            if snap.net_send_mbps <= 0:
                snap.net_send_mbps = derived_sent
        self._prev_bytes = _ByteSample(
            at=now, bytes_received=snap.bytes_received, bytes_sent=snap.bytes_sent
        )

        # WebRTC RTP loss → net_loss when SRT absent
        if snap.net_loss_pct <= 0:
            rtp_lost = self._metric_value(body, "webrtc_sessions_rtp_packets_lost", path=path)
            rtp_recv = self._metric_value(body, "webrtc_sessions_rtp_packets_received", path=path)
            if rtp_recv > 0 and rtp_lost > 0:
                snap.net_loss_pct = min(100.0, (rtp_lost / rtp_recv) * 100.0)

        return snap

    @staticmethod
    def _parse_labels(label_blob: str) -> Dict[str, str]:
        labels: Dict[str, str] = {}
        for match in _LABEL_RE.finditer(label_blob or ""):
            key, value = match.group(1), match.group(2)
            labels[key] = value.encode("utf-8").decode("unicode_escape")
        return labels

    def _iter_samples(self, body: str, name: str) -> List[Tuple[Dict[str, str], float]]:
        out: List[Tuple[Dict[str, str], float]] = []
        prefix_space = name + " "
        prefix_brace = name + "{"
        for line in body.splitlines():
            if line.startswith("#") or not line:
                continue
            if not (line.startswith(prefix_space) or line.startswith(prefix_brace)):
                continue
            match = _LINE_RE.match(line)
            if not match or match.group(1) != name:
                continue
            labels = self._parse_labels(match.group(2) or "")
            try:
                value = float(match.group(3))
            except ValueError:
                continue
            if value != value:  # NaN
                continue
            out.append((labels, value))
        return out

    @staticmethod
    def _sample_path(labels: Dict[str, str]) -> str:
        # Path metrics use name="benchmark"; SRT/RTMP/WebRTC use path="benchmark".
        return labels.get("path") or labels.get("name") or ""

    def _metric_value(self, body: str, name: str, *, path: str = "") -> float:
        samples = self._iter_samples(body, name)
        if not samples:
            return 0.0
        if path:
            exact = [v for labels, v in samples if self._sample_path(labels) == path]
            if exact:
                return float(sum(exact))
            unlabeled = [v for labels, v in samples if not self._sample_path(labels)]
            if unlabeled and len(unlabeled) == len(samples):
                return float(sum(unlabeled))
            return 0.0
        return float(sum(v for _, v in samples))

    def _metric_label_value(
        self, body: str, name: str, label_key: str, *, path: str = ""
    ) -> str:
        for labels, value in self._iter_samples(body, name):
            if path and self._sample_path(labels) not in ("", path):
                continue
            if value <= 0:
                continue
            if label_key in labels:
                return labels[label_key]
        return ""

    @staticmethod
    def _fetch(url: str) -> Optional[str]:
        try:
            request = urllib.request.Request(url, headers={"Accept": "text/plain, application/json"})
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.debug("MediaMTX stats unavailable at %s: %s", url, exc)
            return None
