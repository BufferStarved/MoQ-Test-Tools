"""Error-concealed derived Zixi stream for seamless SRT Fast HLS monitoring.

Zixi's own diagnosis (2026-07-19, Matt): the Fast HLS packager is reused
across SRT reconnects, and a publisher that replays a file from t=0 lands
behind the packager's high-water mark, so the playlist freezes for the whole
session (or a fresh viewer sees media_sequence=0 / chunk=0 / a 404 segment).
Our ``-output_ts_offset`` fix (see ``zixi_ts_offset.py``) prevents that one
symptom, but a *genuine* mid-stream stall/reconnect still hits the same
packager-reuse wall and today only recovers via a disruptive delete+recreate
of the SRT input (``zixi_input_reset.py``).

Zixi's recommended fix is an error-concealed input placed in front of Fast
HLS: it holds a continuous output timeline across reconnects, so the
packager never sees a backward jump and never stalls — seamlessly, for
about +100ms of latency (``delay_ms=100``, ``smoothing=0``). It also masks
continuity-counter errors from genuine packet loss (``fix_cc=1``), which the
timestamp-offset fix does not cover at all.

    GET /zixi/add_stream.json?type=error_concealed&id=<id>&source=<source>
        &continuous_timeline=1&delay_ms=100&smoothing=0&fix_cc=1

This is a persistent, idempotent derived stream — create it once per source
input, not per publish. Deleting/recreating the underlying source input
(our existing heal path) does not require recreating this: it references
the source by name and keeps working once the name is rebound.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode

logger = logging.getLogger("MoQ-SRT-Bench")

_DEFAULT_DELAY_MS = 100
_DEFAULT_SMOOTHING_MS = 0
_EC_SUFFIX = " EC"


def zixi_error_concealed_stream_id(source_stream_id: str) -> str:
    """Derived stream id for `source_stream_id`, e.g. "SRT Test" -> "SRT Test EC"."""
    return f"{(source_stream_id or '').strip()}{_EC_SUFFIX}"


def error_concealment_enabled() -> bool:
    flag = os.environ.get("ZIXI_ERROR_CONCEALMENT_ENABLED", "1").strip().lower()
    return flag not in {"0", "false", "no", "off"}


def _auth_header(user: str, password: str) -> str:
    credentials = f"{user}:{password}".encode("utf-8")
    return "Basic " + base64.b64encode(credentials).decode("ascii")


def _call(base_url: str, path_and_query: str, user: str, password: str) -> bool:
    url = f"{base_url}/{path_and_query}"
    request = urllib.request.Request(url)
    request.add_header("Authorization", _auth_header(user, password))
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()
        return True
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        logger.warning("Zixi error-concealment API call failed (%s): %s", url, exc)
        return False


def _stream_present(base_url: str, user: str, password: str, stream_id: str) -> bool | None:
    """True/False if streams.json was readable, None if the check itself failed.

    See zixi_input_reset._stream_entry — metadata=0 alone must be the only
    query param, or Zixi silently returns an empty "streams" array.
    """
    url = f"{base_url}/zixi/streams.json?metadata=0"
    request = urllib.request.Request(url)
    request.add_header("Authorization", _auth_header(user, password))
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = response.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return None
    try:
        payload = json.loads(body)
    except ValueError:
        return None
    for stream in payload.get("streams", []):
        if stream.get("id") == stream_id:
            return True
    return False


def ensure_error_concealed_stream(
    source_stream_id: str,
    *,
    ec_stream_id: str = "",
    delay_ms: int | None = None,
    smoothing_ms: int | None = None,
    base_url: str = "",
    user: str = "",
    password: str = "",
) -> str | None:
    """Create the error-concealed derived stream if it doesn't already exist.

    Returns the EC stream id on success (already-present or newly created and
    confirmed), or None if concealment is disabled/unconfigured/failed — in
    which case callers should keep pointing playback at `source_stream_id`
    directly (today's behavior) rather than a stream that may not exist.
    """
    if not error_concealment_enabled():
        return None

    source_stream_id = (source_stream_id or "").strip()
    if not source_stream_id:
        return None
    ec_stream_id = (ec_stream_id or zixi_error_concealed_stream_id(source_stream_id)).strip()

    base_url = (base_url or os.environ.get("ZIXI_API_BASE", "")).rstrip("/")
    user = user or os.environ.get("ZIXI_API_USER", "admin")
    password = password or os.environ.get("ZIXI_API_PASSWORD", "")
    if not base_url or not password:
        logger.debug(
            "Zixi error concealment skipped for '%s': ZIXI_API_BASE/ZIXI_API_PASSWORD not set.",
            ec_stream_id,
        )
        return None

    present = _stream_present(base_url, user, password, ec_stream_id)
    if present:
        return ec_stream_id
    if present is None:
        # streams.json itself was unreachable — do not attempt to create blind.
        logger.warning(
            "Zixi error concealment: could not confirm presence of '%s' (API unreachable).",
            ec_stream_id,
        )
        return None

    if delay_ms is None:
        delay_ms = int(os.environ.get("ZIXI_EC_DELAY_MS", str(_DEFAULT_DELAY_MS)))
    if smoothing_ms is None:
        smoothing_ms = int(os.environ.get("ZIXI_EC_SMOOTHING_MS", str(_DEFAULT_SMOOTHING_MS)))

    params = [
        ("type", "error_concealed"),
        ("id", ec_stream_id),
        ("source", source_stream_id),
        ("continuous_timeline", "1"),
        ("delay_ms", str(max(0, delay_ms))),
        ("smoothing", str(max(0, smoothing_ms))),
        ("fix_cc", "1"),
    ]
    query = urlencode(params, quote_via=quote)
    logger.info(
        "Creating Zixi error-concealed stream '%s' (source='%s', delay_ms=%s, smoothing=%s)...",
        ec_stream_id,
        source_stream_id,
        delay_ms,
        smoothing_ms,
    )
    if not _call(base_url, f"zixi/add_stream.json?{query}", user, password):
        return None

    confirmed = _stream_present(base_url, user, password, ec_stream_id)
    if not confirmed:
        logger.warning(
            "Zixi error-concealed stream '%s' not confirmed present after creation.",
            ec_stream_id,
        )
        return None

    logger.info("Zixi error-concealed stream '%s' ready.", ec_stream_id)
    return ec_stream_id
