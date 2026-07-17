"""Reset a Zixi SRT push input before each push.

Root cause (found 2026-07-15): Zixi's SRT push input's HLS segmenter only
successfully cuts segments for the FIRST source connection in the input
object's lifetime. Any later reconnect to the same stream ID — even after a
full `systemctl restart zixibc.service` — never resumes segmenting, because
the per-stream segmenter state persists across process restarts. Only a
genuine delete+recreate of the stream object (via the same API calls the
Zixi UI itself uses) gives a connection that will segment correctly, and
that "first connection" grace is consumed the moment anything connects — so
this must run before every push, not just once.

Configure with the same environment variables used by ZixiStatsPoller:
  ZIXI_API_BASE      e.g. http://35.222.33.58:4444
  ZIXI_API_USER       default admin
  ZIXI_API_PASSWORD
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from urllib.parse import quote, urlencode

logger = logging.getLogger("MoQ-SRT-Bench")

_DEFAULT_REC_DURATION_SEC = 7200
_DEFAULT_REC_HISTORY_SEC = 259200
_DEFAULT_SRT_LATENCY_MS = 200
_DEFAULT_SRT_MAX_BITRATE_BPS = 10_000_000
# Bound on polling for remove/add to actually take effect before the encoder
# starts pushing. A blind sleep(1) sometimes raced Zixi's own API (stream
# still "removing" or not yet bound), which made the encoder connect to a
# half-recreated input — the segmenter then never gets the fresh-object grace
# it needs, and HLS silently stays 1-deep / stale for the whole job.
_POLL_TIMEOUT_SEC = 10.0
_POLL_INTERVAL_SEC = 0.3
# Require repeated observations so a single flaky streams.json read does not
# green-light a push into a half-bound input object.
_CONFIRM_HITS = 2
# After recreate, wait until no clients are attached so an external probe or
# leftover session cannot burn the first-connection HLS segmenter grace.
_IDLE_TIMEOUT_SEC = 3.0
_SETTLE_AFTER_READY_SEC = 0.4


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
        logger.warning("Zixi SRT input reset call failed (%s): %s", url, exc)
        return False


def _stream_entry(base_url: str, user: str, password: str, stream_id: str) -> dict | None | bool:
    """Return the stream dict, False if absent, None if the listing failed.

    NOTE: combining pagesize+page+metadata on this endpoint makes Zixi return
    an empty "streams" array (reproduced directly against the broadcaster
    API), which silently broke every wait_for_stream_state confirmation.
    metadata=0 alone still returns full stream entries, so use just that.
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
            return stream if isinstance(stream, dict) else {}
    return False


def _stream_present(base_url: str, user: str, password: str, stream_id: str) -> bool | None:
    """True/False if streams.json was readable, None if the check itself failed."""
    entry = _stream_entry(base_url, user, password, stream_id)
    if entry is None:
        return None
    return entry is not False


def _wait_for_stream_state(
    base_url: str,
    user: str,
    password: str,
    stream_id: str,
    *,
    want_present: bool,
    timeout_sec: float = _POLL_TIMEOUT_SEC,
    consecutive: int = _CONFIRM_HITS,
) -> bool:
    """Poll until stream presence matches `want_present` for `consecutive` hits."""
    deadline = time.monotonic() + timeout_sec
    hits = 0
    while time.monotonic() < deadline:
        present = _stream_present(base_url, user, password, stream_id)
        if present is None:
            hits = 0
        elif present == want_present:
            hits += 1
            if hits >= consecutive:
                return True
        else:
            hits = 0
        time.sleep(_POLL_INTERVAL_SEC)
    return False


def _wait_for_idle_input(
    base_url: str,
    user: str,
    password: str,
    stream_id: str,
    *,
    timeout_sec: float = _IDLE_TIMEOUT_SEC,
) -> bool:
    """Wait until the recreated input reports zero clients (exclusive first connect)."""
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        entry = _stream_entry(base_url, user, password, stream_id)
        if entry is None:
            time.sleep(_POLL_INTERVAL_SEC)
            continue
        if entry is False:
            return False
        try:
            clients = int(entry.get("clients") or 0)
        except (TypeError, ValueError):
            clients = 0
        if clients <= 0:
            return True
        logger.info(
            "Zixi SRT input '%s' still has %s client(s); waiting for exclusive first connect...",
            stream_id,
            clients,
        )
        time.sleep(_POLL_INTERVAL_SEC)
    logger.warning(
        "Zixi SRT input '%s' still had attached clients after %.1fs; "
        "first-connection HLS grace may already be burned.",
        stream_id,
        timeout_sec,
    )
    return False


def reset_zixi_srt_input(
    stream_id: str,
    *,
    port: int,
    base_url: str = "",
    user: str = "",
    password: str = "",
    srt_latency_ms: int | None = None,
    max_bitrate_kbps: int | None = None,
) -> bool:
    """Delete and recreate a Zixi SRT push input so its HLS segmenter starts fresh.

    Returns True only when the new stream object is confirmed present and idle.
    Callers that need reliable HLS must treat False as fatal (retry, then fail).
    """
    base_url = (base_url or os.environ.get("ZIXI_API_BASE", "")).rstrip("/")
    user = user or os.environ.get("ZIXI_API_USER", "admin")
    password = password or os.environ.get("ZIXI_API_PASSWORD", "")

    if not base_url or not password:
        logger.warning(
            "Zixi SRT input reset skipped: ZIXI_API_BASE/ZIXI_API_PASSWORD not set. "
            "HLS will likely loop the previous encode's last segment until the input is reset."
        )
        return False

    stream_enc = quote(stream_id, safe="")

    logger.info("Resetting Zixi SRT input '%s' before push...", stream_id)
    _call(base_url, f"zixi/remove_stream.json?id={stream_enc}", user, password)
    if not _wait_for_stream_state(base_url, user, password, stream_id, want_present=False):
        logger.warning(
            "Zixi did not confirm '%s' removal within %.0fs.",
            stream_id,
            _POLL_TIMEOUT_SEC,
        )
        # Still attempt add_stream — Zixi may accept a replace — but do not
        # claim success unless presence is confirmed below.

    add_params = [
        ("id", stream_id),
        ("matrix", "1"),
        ("support_scte", "0"),
        ("support_scte_pid", "AUTO"),
        ("support_scte_cleanup", "0"),
        ("support_scte_timeout", ""),
        ("log_this_stream", "0"),
        ("metadata", "0"),
        ("analyze", "0"),
        ("max_outputs", "-1"),
        ("latency_offset", "0"),
        ("mcast_out", "0"),
        ("time_shift", "0"),
        ("enc-type", ""),
        ("enc-key", ""),
        ("fast-connect", "0"),
        ("kompression", "1"),
        ("rec_duration", str(_DEFAULT_REC_DURATION_SEC)),
        ("rec_template", "%S_%Y%M%D-%T.ts"),
        ("s3", "0"),
        ("rec_history", str(_DEFAULT_REC_HISTORY_SEC)),
        ("rec_path", ""),
        ("type", "SRT"),
        ("port", str(port)),
        (
            "max_bitrate",
            str(
                int(max_bitrate_kbps) * 1000
                if max_bitrate_kbps is not None and int(max_bitrate_kbps) > 0
                else _DEFAULT_SRT_MAX_BITRATE_BPS
            ),
        ),
        ("pass", ""),
        ("nic", ""),
        (
            "srt_latency",
            str(
                int(srt_latency_ms)
                if srt_latency_ms is not None and int(srt_latency_ms) > 0
                else _DEFAULT_SRT_LATENCY_MS
            ),
        ),
        ("verify_streamid", "0"),
        ("srt_version", "1.5.5"),
    ]
    add_qs = urlencode(add_params, quote_via=quote)
    ok = _call(base_url, f"zixi/add_stream.json?func=load_live_inputs&{add_qs}", user, password)
    if not ok:
        return False

    _call(
        base_url,
        f"set_live_recording.json?func=hard_reload_inputs_table&id={stream_enc}&on=1",
        user,
        password,
    )

    # Encoder must not start pushing before the new input object is bound —
    # a push that lands during that gap gets treated as a reconnect on stale
    # state, silently forfeiting the "first connection" grace the segmenter
    # needs. This is the actual source of "sometimes HLS just never comes up."
    if not _wait_for_stream_state(base_url, user, password, stream_id, want_present=True):
        logger.error(
            "Zixi did not confirm '%s' was recreated within %.0fs — refusing to push.",
            stream_id,
            _POLL_TIMEOUT_SEC,
        )
        return False

    if not _wait_for_idle_input(base_url, user, password, stream_id):
        # Still present; proceed only if we at least own the exclusive window soon.
        # Fail closed when something else is already attached — that burns grace.
        entry = _stream_entry(base_url, user, password, stream_id)
        if isinstance(entry, dict):
            try:
                clients = int(entry.get("clients") or 0)
            except (TypeError, ValueError):
                clients = 0
            if clients > 0:
                logger.error(
                    "Zixi SRT input '%s' has %s client(s) before our push — "
                    "HLS first-connection grace is already consumed.",
                    stream_id,
                    clients,
                )
                return False

    time.sleep(_SETTLE_AFTER_READY_SEC)
    logger.info("Zixi SRT input '%s' reset verified (present + idle).", stream_id)
    return True


def reset_zixi_srt_input_with_retry(
    stream_id: str,
    *,
    port: int,
    attempts: int = 2,
    srt_latency_ms: int | None = None,
    max_bitrate_kbps: int | None = None,
) -> bool:
    """Run delete+recreate up to `attempts` times; return True on first verified success."""
    for attempt in range(1, max(1, attempts) + 1):
        logger.info(
            "Zixi SRT input reset attempt %s/%s for '%s'...",
            attempt,
            attempts,
            stream_id,
        )
        if reset_zixi_srt_input(
            stream_id,
            port=port,
            srt_latency_ms=srt_latency_ms,
            max_bitrate_kbps=max_bitrate_kbps,
        ):
            return True
        time.sleep(0.5)
    return False


def remove_zixi_srt_input(
    stream_id: str,
    *,
    base_url: str = "",
    user: str = "",
    password: str = "",
) -> bool:
    """Delete a Zixi SRT push input after a job finishes.

    Per-job stream IDs (one input object per benchmark run) avoid the
    first-connection segmenter race between overlapping jobs, but they also
    mean Zixi's stream table accumulates one orphaned input per run unless
    something deletes it afterwards. Best-effort — callers should not fail
    the job over a cleanup error.
    """
    base_url = (base_url or os.environ.get("ZIXI_API_BASE", "")).rstrip("/")
    user = user or os.environ.get("ZIXI_API_USER", "admin")
    password = password or os.environ.get("ZIXI_API_PASSWORD", "")

    if not base_url or not password:
        return False

    stream_enc = quote(stream_id, safe="")
    logger.info("Removing per-job Zixi SRT input '%s' after push...", stream_id)
    ok = _call(base_url, f"zixi/remove_stream.json?id={stream_enc}", user, password)
    _wait_for_stream_state(base_url, user, password, stream_id, want_present=False)
    return ok
