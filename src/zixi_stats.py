import base64
import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional
from urllib.parse import parse_qs, quote, unquote_plus, urlparse

import urllib.error
import urllib.request

logger = logging.getLogger("MoQ-SRT-Bench")

# Verified against Zixi Broadcaster UI (bc_input_scripts.js / ts_analysis.js on
# /opt/zixi_broadcaster-linux64/html/js/) and live calls on the GCP ingest VM:
#   input_stream_stats.json?func=fill_inputs_stats&id=<stream_id>
#   input_stream_stats.json?func=fill_ts_anaysis_data&id=<stream_id>  # Zixi typo: "anaysis"
# The legacy /api/v1/inputs/*/statistics paths return HTTP 500 on this install.


@dataclass
class ZixiStatsSnapshot:
    rtt_ms: float = 0.0
    jitter_ms: float = 0.0
    packet_loss_pct: float = 0.0
    cc_errors: int = 0
    rtp_drops: int = 0
    connected: bool = False
    bitrate_kbps: float = 0.0
    packet_rate: float = 0.0
    kb_received: float = 0.0
    total_packets: float = 0.0


def parse_zixi_jsonp(payload: str) -> Dict[str, Any]:
    """Parse Zixi JSON or JSONP callback responses."""
    text = payload.strip()
    if not text:
        raise ValueError("empty response")
    if text[0] in "{[":
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    open_paren = text.find("(")
    if open_paren == -1:
        raise ValueError("unrecognized Zixi response format")
    body = text[open_paren + 1 :]
    if body.endswith(");"):
        body = body[:-2]
    elif body.endswith(")"):
        body = body[:-1]
    data = json.loads(body)
    return data if isinstance(data, dict) else {}


def _nested_float(data: Dict[str, Any], *path: str, default: float = 0.0) -> float:
    node: Any = data
    for key in path:
        if not isinstance(node, dict):
            return default
        node = node.get(key)
    if node is None:
        return default
    try:
        return float(node)
    except (TypeError, ValueError):
        return default


def _nested_int(data: Dict[str, Any], *path: str, default: int = 0) -> int:
    return int(_nested_float(data, *path, default=default))


def _tr101_error_count(data: Dict[str, Any], error_name: str) -> int:
    tr101 = data.get("tr101")
    if not isinstance(tr101, list):
        return 0

    total = 0
    for group in tr101:
        if not isinstance(group, list):
            continue
        for entry in group:
            if not isinstance(entry, dict):
                continue
            if entry.get("name") != error_name:
                continue
            try:
                total += int(entry.get("count", 0) or 0)
            except (TypeError, ValueError):
                continue
    return total


def snapshot_from_zixi_payload(data: Dict[str, Any]) -> ZixiStatsSnapshot:
    """Map Zixi input_stream_stats JSON to our benchmark snapshot fields."""
    net = data.get("net") if isinstance(data.get("net"), dict) else {}
    failover = data.get("failover") if isinstance(data.get("failover"), dict) else {}

    rtt_ms = _nested_float(data, "net", "rtt")
    jitter_ms = _nested_float(data, "net", "jitter")
    packet_loss_pct = _nested_float(data, "net", "loss_millipercent") / 1000.0

    # Prefer failover RTP drops when present; otherwise use receiver net drops.
    rtp_drops = _nested_int(data, "failover", "rtp_drops")
    if rtp_drops == 0:
        rtp_drops = _nested_int(data, "net", "dropped")

    cc_errors = _tr101_error_count(data, "Continuity_count_error")
    if cc_errors == 0:
        # HLS pull inputs expose CC errors under hls.cc_errors in the UI.
        cc_errors = _nested_int(data, "hls", "cc_errors")

    # Bonded / multi-link inputs surface per-link RTT in links[].
    if rtt_ms <= 0 and isinstance(data.get("links"), list):
        for link in data["links"]:
            if not isinstance(link, dict):
                continue
            link_net = link.get("net") if isinstance(link.get("net"), dict) else {}
            link_rtt = float(link_net.get("rtt", 0) or 0)
            link_jitter = float(link_net.get("jitter", 0) or 0)
            if link_rtt > 0:
                rtt_ms = link_rtt
            if link_jitter > 0 and jitter_ms <= 0:
                jitter_ms = link_jitter

    return ZixiStatsSnapshot(
        rtt_ms=rtt_ms,
        jitter_ms=jitter_ms,
        packet_loss_pct=packet_loss_pct,
        cc_errors=cc_errors,
        rtp_drops=rtp_drops,
        connected=bool(data.get("connected")),
        bitrate_kbps=_nested_float(data, "net", "bitrate"),
        packet_rate=_nested_float(data, "net", "packet_rate"),
        kb_received=_nested_float(data, "net", "kb_received"),
        total_packets=_nested_float(data, "net", "total_packets"),
    )


def zixi_ingest_observed(stats: Optional[ZixiStatsSnapshot]) -> bool:
    """True when Zixi has seen media, not just a TCP/SRT RTT.

    RTMP inputs often report rtt=0 while kb_received / bitrate / packets
    move (comparison 31 Linode rtmp://45.33.68.151). Treating RTT-only as
    first_byte_ingest left the CSV blank for a live publish.
    """
    if stats is None:
        return False
    if (stats.rtt_ms or 0) > 0:
        return True
    if (stats.bitrate_kbps or 0) > 0 or (stats.packet_rate or 0) > 0:
        return True
    if stats.connected and ((stats.kb_received or 0) > 0 or (stats.total_packets or 0) > 0):
        return True
    return False


def zixi_api_base_for_endpoint(endpoint_url: str = "") -> str:
    """Zixi UI/API origin for a publish URL.

    Multi-region stacks share one admin password but each Broadcaster has its
    own :4444. Prefer the destination host so east/Linode jobs do not hit
    us-central1 just because ``ZIXI_API_BASE`` is set on the orchestrator.
    """
    host = urlparse(endpoint_url or "").hostname
    if host:
        return f"http://{host}:4444"
    return os.environ.get("ZIXI_API_BASE", "").rstrip("/")


def _managed_zixi_hosts() -> set[str]:
    from cloud_placement import ENCODE_HOSTS, host_zixi_ip

    hosts = {
        "35.222.33.58",
        os.environ.get("GCP_ZIXI_IP", "").strip(),
    }
    for encode_host in ENCODE_HOSTS:
        hosts.add(host_zixi_ip(encode_host))
    hosts.discard("")
    return hosts


class ZixiStatsPoller:
    """
    Optional receiver-side stats from Zixi Broadcaster REST API.

    Configure with environment variables:
      ZIXI_API_BASE   e.g. http://35.222.33.58:4444
      ZIXI_API_USER   default admin
      ZIXI_API_PASSWORD
      ZIXI_INPUT_ID   optional input stream id/name
    """

    def __init__(
        self,
        endpoint_url: str,
        input_id: Optional[str] = None,
        *,
        enabled: Optional[bool] = None,
        agent_fetch: Optional[Callable[[str, str], Optional[str]]] = None,
    ):
        self._enabled = False
        self._base_url = zixi_api_base_for_endpoint(endpoint_url)
        self._user = os.environ.get("ZIXI_API_USER", "admin")
        self._password = os.environ.get("ZIXI_API_PASSWORD", "")
        env_input = os.environ.get("ZIXI_INPUT_ID", "").strip()
        self._input_id = (
            (input_id or "").strip()
            or env_input
            or self._stream_id_from_url(endpoint_url)
        )
        # GCP managed SRT preset omits streamid in the public URL; default to Zixi input name.
        if not self._input_id and self._looks_like_gcp_zixi_srt(endpoint_url):
            self._input_id = "SRT Test"
        self._latest = ZixiStatsSnapshot()
        self._agent_fetch = agent_fetch

        if enabled is False:
            self._enabled = False
        elif enabled is True or self._agent_fetch is not None or self._password:
            self._enabled = True

    @staticmethod
    def _looks_like_gcp_zixi_srt(endpoint_url: str) -> bool:
        parsed = urlparse(endpoint_url)
        if parsed.scheme != "srt" or not parsed.hostname:
            return False
        if parsed.hostname in _managed_zixi_hosts():
            return True
        return (parsed.port or 0) == 10080

    @staticmethod
    def _stream_id_from_url(endpoint_url: str) -> str:
        parsed = urlparse(endpoint_url)
        if parsed.scheme == "srt":
            streamid = ""
            query = parse_qs(parsed.query)
            streamid = (query.get("streamid") or [""])[0]
            if not streamid:
                # Zixi access-mode streamids embed "#!::r=..." which urlparse treats as a fragment.
                match = re.search(r"streamid=([^&]+)", endpoint_url, flags=re.IGNORECASE)
                if match:
                    streamid = match.group(1)
            streamid = unquote_plus(streamid) if "%" in streamid else streamid
            if streamid.startswith("#!::r="):
                resource = streamid.split(",")[0].removeprefix("#!::r=")
                return resource
            return streamid
        if parsed.scheme == "rtmp":
            parts = [part for part in parsed.path.split("/") if part]
            return parts[-1] if parts else ""
        if parsed.scheme in {"http", "https"}:
            parts = [part for part in parsed.path.split("/") if part]
            if not parts:
                return ""
            stream_id = parts[0]
            for suffix in (".m3u8", ".mpd"):
                if stream_id.endswith(suffix):
                    stream_id = stream_id[: -len(suffix)]
            return stream_id
        return ""

    @property
    def enabled(self) -> bool:
        return self._enabled

    def poll(self) -> ZixiStatsSnapshot:
        if not self._enabled:
            return self._latest

        stats_payload = self._fetch_input_stats(func="fill_inputs_stats")
        # A firewalled :4444 used to cost 3s × 2 fetches and starve the sample
        # loop. If the first call fails, skip analysis for this tick.
        analysis_payload = (
            self._fetch_input_stats(func="fill_ts_anaysis_data")
            if stats_payload is not None
            else None
        )

        if stats_payload is None and analysis_payload is None:
            return self._latest

        merged: Dict[str, Any] = {}
        if stats_payload:
            merged.update(stats_payload)
        if analysis_payload:
            for key, value in analysis_payload.items():
                if key == "tr101" or key not in merged or merged.get(key) in (None, "", 0):
                    merged[key] = value

        self._latest = snapshot_from_zixi_payload(merged)
        return self._latest

    def _fetch_input_stats(self, func: str) -> Optional[Dict[str, Any]]:
        if not self._input_id:
            logger.debug("Zixi stats skipped: no input id (set ZIXI_INPUT_ID or use a URL with stream id).")
            return None

        encoded_id = quote(self._input_id, safe="")
        if self._agent_fetch is not None:
            payload = self._agent_fetch(func, self._input_id)
        else:
            url = f"{self._base_url}/input_stream_stats.json?func={func}&id={encoded_id}"
            payload = self._fetch(url)
        if payload is None:
            return None

        try:
            return parse_zixi_jsonp(payload)
        except (json.JSONDecodeError, ValueError) as exc:
            logger.debug("Zixi stats parse failed for %s: %s", func, exc)
            return None

    def _fetch(self, url: str) -> Optional[str]:
        request = urllib.request.Request(url)
        credentials = f"{self._user}:{self._password}".encode("utf-8")
        request.add_header(
            "Authorization",
            "Basic " + base64.b64encode(credentials).decode("ascii"),
        )

        try:
            with urllib.request.urlopen(request, timeout=0.8) as response:
                return response.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            logger.debug("Zixi stats unavailable at %s: %s", url, exc)
            return None
