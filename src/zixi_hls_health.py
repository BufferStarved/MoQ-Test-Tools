"""Probe Zixi HLS origin readiness for SRT preview gating and mid-job heal.

Zixi often advertises playback.ts?chunk=N before the chunk is readable (HTTP 400).
Treat preview as ready only when the playlist lists a segment AND that segment
returns a real MPEG-TS body (sync byte 0x47, ≥188 bytes).
"""

from __future__ import annotations

import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

logger = logging.getLogger("MoQ-SRT-Bench")

_DEFAULT_HLS_PORT = 7777
_TS_SYNC = 0x47
_MIN_TS_BYTES = 188


@dataclass(frozen=True)
class HlsHealth:
    ok: bool
    media_sequence: Optional[int] = None
    segment_uri: Optional[str] = None
    depth: int = 0
    segment_ready: bool = False
    http_status: Optional[int] = None
    detail: str = ""


def zixi_hls_host_from_endpoint(endpoint_url: str) -> str:
    """Host for :7777 HLS origin — usually the same as the SRT/RTMP ingest host."""
    parsed = urlparse(endpoint_url)
    if parsed.hostname:
        return parsed.hostname
    api_base = os.environ.get("ZIXI_API_BASE", "").rstrip("/")
    if api_base:
        return urlparse(api_base).hostname or "127.0.0.1"
    return "127.0.0.1"


def zixi_hls_playback_url(stream_id: str, *, endpoint_url: str = "", port: int = _DEFAULT_HLS_PORT) -> str:
    host = zixi_hls_host_from_endpoint(endpoint_url) if endpoint_url else zixi_hls_host_from_endpoint("")
    return f"http://{host}:{port}/playback.m3u8?stream={urllib.parse.quote(stream_id, safe='')}"


def _media_sequence(body: str) -> Optional[int]:
    match = re.search(r"#EXT-X-MEDIA-SEQUENCE:(\d+)", body)
    if not match:
        return None
    try:
        return int(match.group(1))
    except ValueError:
        return None


def _segment_uri(body: str) -> Optional[str]:
    for line in body.splitlines():
        row = line.strip()
        if row and not row.startswith("#"):
            return row
    return None


def _playlist_depth(body: str) -> int:
    return sum(1 for line in body.splitlines() if line.strip() and not line.strip().startswith("#"))


def _sanitize_http_url(url: str) -> str:
    """Re-quote path/query so Zixi playlist lines with raw spaces are fetchable.

    Zixi emits segment URIs like ``playback.ts?stream=SRT Test&chunk=0``. Python's
    http.client rejects those with InvalidURL; browsers and our playback proxy
    percent-encode them. Mirror that here so preview gating cannot crash the job.
    """
    parts = urllib.parse.urlsplit(url.strip())
    query = urllib.parse.urlencode(
        urllib.parse.parse_qsl(parts.query, keep_blank_values=True),
        quote_via=urllib.parse.quote,
    )
    path = urllib.parse.quote(urllib.parse.unquote(parts.path), safe="/:@")
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))


def _fetch(url: str, *, timeout: float = 5.0) -> tuple[Optional[int], bytes]:
    safe_url = _sanitize_http_url(url)
    request = urllib.request.Request(safe_url, headers={"Cache-Control": "no-store"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        try:
            body = exc.read()
        except Exception:
            body = b""
        return exc.code, body
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None, b""


def probe_hls_segment_ready(manifest_url: str, *, timeout: float = 5.0) -> HlsHealth:
    """Return ok=True only when a playlist segment fetches as real MPEG-TS."""
    try:
        status, raw = _fetch(manifest_url, timeout=timeout)
    except Exception as exc:
        logger.warning("HLS manifest probe failed for %s: %s", manifest_url, exc)
        return HlsHealth(ok=False, detail=f"manifest_probe_error={exc}")
    if status != 200:
        return HlsHealth(
            ok=False,
            http_status=status,
            detail=f"manifest_http={status if status is not None else 'error'}",
        )
    try:
        body = raw.decode("utf-8", errors="replace")
    except Exception:
        return HlsHealth(ok=False, http_status=status, detail="manifest_decode_error")
    if "#EXTM3U" not in body:
        return HlsHealth(ok=False, http_status=status, detail="not_m3u8")

    sequence = _media_sequence(body)
    segment = _segment_uri(body)
    depth = _playlist_depth(body)
    if not segment:
        return HlsHealth(
            ok=False,
            media_sequence=sequence,
            depth=depth,
            http_status=status,
            detail="no_segment",
        )

    segment_url = _sanitize_http_url(urllib.parse.urljoin(manifest_url, segment))
    try:
        seg_status, seg_bytes = _fetch(segment_url, timeout=timeout)
    except Exception as exc:
        logger.warning("HLS segment probe failed for %s: %s", segment_url, exc)
        return HlsHealth(
            ok=False,
            media_sequence=sequence,
            segment_uri=segment,
            depth=depth,
            detail=f"segment_probe_error={exc}",
        )
    ready = (
        seg_status == 200
        and len(seg_bytes) >= _MIN_TS_BYTES
        and seg_bytes[0] == _TS_SYNC
    )
    return HlsHealth(
        ok=ready,
        media_sequence=sequence,
        segment_uri=segment,
        depth=depth,
        segment_ready=ready,
        http_status=seg_status,
        detail=(
            "segment_ready"
            if ready
            else f"segment_http={seg_status if seg_status is not None else 'error'} bytes={len(seg_bytes)}"
        ),
    )
