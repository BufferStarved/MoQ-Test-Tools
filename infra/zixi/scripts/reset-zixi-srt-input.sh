#!/usr/bin/env bash
# Delete and recreate the Zixi SRT push input immediately before each push.
#
# Root cause (found 2026-07-15): Zixi's SRT push input's HLS segmenter only
# successfully cuts segments for the FIRST source connection in the input
# object's lifetime. Any later reconnect to the same stream ID — even after a
# full `systemctl restart zixibc.service` — never resumes segmenting, because
# the per-stream segmenter state persists across process restarts and only a
# genuine delete+recreate of the stream object gives a connection that will
# segment correctly. That "first connection" grace is consumed the moment
# anything connects, so this must run before every push, not just once.
#
# Usage:
#   ZIXI_PASSWORD=... ./infra/zixi/scripts/reset-zixi-srt-input.sh
#
# Environment:
#   ZIXI_HOST            Zixi UI host (default: 35.222.33.58)
#   ZIXI_PORT            Zixi UI port (default: 4444)
#   ZIXI_USER            Admin username (default: admin)
#   ZIXI_PASSWORD        Admin password (required)
#   ZIXI_SRT_STREAM      SRT input stream ID (default: SRT Test)
#   ZIXI_SRT_PORT        SRT listen port (default: 10080)
#   ZIXI_SRT_MAX_BITRATE Max bitrate in bps (default: 10000000)
#   ZIXI_SRT_LATENCY     SRT latency in ms (default: 200)
#   ZIXI_REC_DURATION    Recording file duration in seconds (default: 7200)
#   ZIXI_REC_HISTORY     Recording history retention in seconds (default: 259200)
set -euo pipefail

ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
ZIXI_PORT="${ZIXI_PORT:-4444}"
ZIXI_USER="${ZIXI_USER:-admin}"
ZIXI_PASSWORD="${ZIXI_PASSWORD:-}"
ZIXI_SRT_STREAM="${ZIXI_SRT_STREAM:-SRT Test}"
ZIXI_SRT_PORT="${ZIXI_SRT_PORT:-10080}"
ZIXI_SRT_MAX_BITRATE="${ZIXI_SRT_MAX_BITRATE:-10000000}"
ZIXI_SRT_LATENCY="${ZIXI_SRT_LATENCY:-200}"
ZIXI_REC_DURATION="${ZIXI_REC_DURATION:-7200}"
ZIXI_REC_HISTORY="${ZIXI_REC_HISTORY:-259200}"

if [[ -z "$ZIXI_PASSWORD" ]]; then
  echo "Set ZIXI_PASSWORD (Zixi admin password)." >&2
  exit 1
fi

BASE_URL="http://${ZIXI_HOST}:${ZIXI_PORT}"
AUTH=(-u "${ZIXI_USER}:${ZIXI_PASSWORD}")

encode() {
  python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

zixi_call() {
  local url="$1"
  local response
  response="$(curl -sS "${AUTH[@]}" "$url")"
  if [[ "$response" == *"401 Unauthorized"* ]]; then
    echo "Zixi authentication failed for ${ZIXI_USER}@${ZIXI_HOST}:${ZIXI_PORT}" >&2
    exit 1
  fi
  echo "$response"
}

STREAM_ENC="$(encode "$ZIXI_SRT_STREAM")"

echo "Removing '${ZIXI_SRT_STREAM}' (if present) to clear any wedged HLS segmenter state..."
zixi_call "${BASE_URL}/zixi/remove_stream.json?id=${STREAM_ENC}" >/dev/null || true
sleep 1

echo "Recreating '${ZIXI_SRT_STREAM}' as a fresh SRT push input on port ${ZIXI_SRT_PORT}..."
ADD_QS="$(python3 -c "
import urllib.parse
params = [
    ('id', '${ZIXI_SRT_STREAM}'),
    ('matrix', '1'),
    ('support_scte', '0'),
    ('support_scte_pid', 'AUTO'),
    ('support_scte_cleanup', '0'),
    ('support_scte_timeout', ''),
    ('log_this_stream', '0'),
    ('metadata', '0'),
    ('analyze', '0'),
    ('max_outputs', '-1'),
    ('latency_offset', '0'),
    ('mcast_out', '0'),
    ('time_shift', '0'),
    ('enc-type', ''),
    ('enc-key', ''),
    ('fast-connect', '0'),
    ('kompression', '1'),
    ('rec_duration', '${ZIXI_REC_DURATION}'),
    ('rec_template', '%S_%Y%M%D-%T.ts'),
    ('s3', '0'),
    ('rec_history', '${ZIXI_REC_HISTORY}'),
    ('rec_path', ''),
    ('type', 'SRT'),
    ('port', '${ZIXI_SRT_PORT}'),
    ('max_bitrate', '${ZIXI_SRT_MAX_BITRATE}'),
    ('pass', ''),
    ('nic', ''),
    ('srt_latency', '${ZIXI_SRT_LATENCY}'),
    ('verify_streamid', '0'),
    ('srt_version', '1.5.5'),
]
print(urllib.parse.urlencode(params, quote_via=urllib.parse.quote))
")"
zixi_call "${BASE_URL}/zixi/add_stream.json?func=load_live_inputs&${ADD_QS}" >/dev/null

echo "Enabling live recording for '${ZIXI_SRT_STREAM}'..."
zixi_call "${BASE_URL}/set_live_recording.json?func=hard_reload_inputs_table&id=${STREAM_ENC}&on=1" >/dev/null

echo "Reset complete. '${ZIXI_SRT_STREAM}' is ready for a single fresh push."
