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


def zixi_http_ts_playback_url(
    stream_id: str,
    *,
    endpoint_url: str = "",
    port: int = _DEFAULT_HLS_PORT,
) -> str:
    """Raw MPEG-TS over HTTP (``http_ts_auto_out``) — bypasses the Fast HLS packager."""
    host = zixi_hls_host_from_endpoint(endpoint_url) if endpoint_url else zixi_hls_host_from_endpoint("")
    clean = (stream_id or "benchmark").strip() or "benchmark"
    return f"http://{host}:{port}/{urllib.parse.quote(clean, safe='')}.ts"


def probe_http_ts_ready(
    stream_id: str,
    *,
    endpoint_url: str = "",
    timeout: float = 4.0,
) -> HlsHealth:
    """True when ``/<stream>.ts`` returns MPEG-TS sync bytes (TS-PUT / http_ts_auto_out)."""
    url = zixi_http_ts_playback_url(stream_id, endpoint_url=endpoint_url)
    try:
        status, raw = _fetch(url, timeout=timeout)
    except Exception as exc:
        return HlsHealth(ok=False, detail=f"http_ts_probe_error={exc}")
    ready = status == 200 and _looks_like_media_bytes(raw)
    return HlsHealth(
        ok=ready,
        segment_uri=url,
        segment_ready=ready,
        http_status=status,
        detail="http_ts_ready" if ready else f"http_ts_http={status if status is not None else 'error'} bytes={len(raw)}",
    )


def capture_zixi_http_ts(
    stream_id: str,
    dest_path: str,
    *,
    endpoint_url: str = "",
    duration_sec: float = 8.0,
    ffmpeg_bin: str = "ffmpeg",
) -> Optional[str]:
    """Pull a short HTTP-TS sample for VMAF/stats. Returns dest_path on success."""
    import subprocess

    url = zixi_http_ts_playback_url(stream_id, endpoint_url=endpoint_url)
    try:
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                url,
                "-t",
                str(max(1.0, float(duration_sec))),
                "-c",
                "copy",
                dest_path,
            ],
            capture_output=True,
            text=True,
            timeout=max(30, int(duration_sec) + 20),
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("HTTP-TS capture failed for %s: %s", url, exc)
        return None
    if proc.returncode != 0 or not os.path.isfile(dest_path) or os.path.getsize(dest_path) < _MIN_TS_BYTES:
        logger.warning(
            "HTTP-TS capture empty/failed for %s (code=%s): %s",
            url,
            proc.returncode,
            (proc.stderr or "").strip()[-400:],
        )
        return None
    return dest_path


_DEFAULT_MEDIAMTX_HLS_PORT = 8888


def mediamtx_hls_playback_url(
    path: str = "benchmark",
    *,
    endpoint_url: str = "",
    port: int = _DEFAULT_MEDIAMTX_HLS_PORT,
) -> str:
    """LL-HLS playlist for a MediaMTX path (e.g. /benchmark/index.m3u8)."""
    host = zixi_hls_host_from_endpoint(endpoint_url) if endpoint_url else zixi_hls_host_from_endpoint("")
    clean = (path or "benchmark").strip().strip("/") or "benchmark"
    return f"http://{host}:{port}/{urllib.parse.quote(clean, safe='')}/index.m3u8"


def mediamtx_hls_probe_url(
    path: str = "benchmark",
    *,
    port: int = _DEFAULT_MEDIAMTX_HLS_PORT,
) -> str:
    """Server-side LL-HLS probe URL (loopback).

    Co-located moq-web must not hairpin to the VM public IP — those GETs hang
    and stall the sample loop / preview gate. Browsers still use the public host
    via ``mediamtx_hls_playback_url`` / the SPA.
    """
    host = (os.environ.get("MEDIAMTX_PROBE_HOST", "127.0.0.1").strip() or "127.0.0.1")
    clean = (path or "benchmark").strip().strip("/") or "benchmark"
    return f"http://{host}:{port}/{urllib.parse.quote(clean, safe='')}/index.m3u8"


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


def _looks_like_media_bytes(data: bytes) -> bool:
    """True for MPEG-TS (Zixi) or fMP4 init/media (MediaMTX LL-HLS)."""
    if len(data) >= _MIN_TS_BYTES and data[0] == _TS_SYNC:
        return True
    if len(data) >= 8 and data[4:8] in (b"ftyp", b"moof", b"mdat"):
        return True
    if len(data) >= 32 and (b"ftyp" in data[:32] or b"moof" in data[:32]):
        return True
    # LL-HLS partials can be small CMAF chunks.
    return len(data) >= 64 and (b"moof" in data[:64] or b"mdat" in data[:64])


def probe_hls_segment_ready(
    manifest_url: str,
    *,
    timeout: float = 5.0,
    _depth: int = 0,
) -> HlsHealth:
    """Return ok=True when a playlist media URI fetches as MPEG-TS or fMP4."""
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

    # Follow one master→media hop (MediaMTX index.m3u8 is often a multivariant).
    segment = _segment_uri(body)
    if segment and segment.endswith(".m3u8") and _depth < 2:
        nested_url = _sanitize_http_url(urllib.parse.urljoin(manifest_url, segment))
        return probe_hls_segment_ready(nested_url, timeout=timeout, _depth=_depth + 1)

    # LL-HLS: prefer first EXT-X-PART URI when present.
    part_match = re.search(r'#EXT-X-PART:[^\n]*URI="([^"]+)"', body)
    if part_match:
        segment = part_match.group(1)

    sequence = _media_sequence(body)
    if not segment:
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
    ready = seg_status == 200 and _looks_like_media_bytes(seg_bytes)
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
