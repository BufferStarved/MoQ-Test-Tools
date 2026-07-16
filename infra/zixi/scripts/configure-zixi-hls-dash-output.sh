#!/usr/bin/env bash
# Enable Zixi HTTP origin output (HLS + DASH/CMAF) and HTTP TS push ingest.
#
# Zixi architecture (per-input streams):
#   - Ingest: RTMP or MPEG-TS over HTTP push
#   - HLS output (live): http://<host>:7777/playback.m3u8?stream=<stream-id>
#   - DASH: may require adaptive groups; /<stream-id>.mpd is probed as a best effort
#
# IMPORTANT: Live Protocols changes require a Zixi restart before they take effect.
#
# Usage:
#   ZIXI_PASSWORD=... ./infra/zixi/scripts/configure-zixi-hls-dash-output.sh
#   ZIXI_HOST=35.222.33.58 ZIXI_PASSWORD=... ./infra/zixi/scripts/configure-zixi-hls-dash-output.sh
#
# Environment:
#   ZIXI_HOST              Zixi UI host (default: 127.0.0.1)
#   ZIXI_PORT              Zixi UI port (default: 4444)
#   ZIXI_USER              Admin username (default: admin)
#   ZIXI_PASSWORD          Admin password (required)
#   ZIXI_STREAM_ID         Stream ID (default: benchmark)
#   ZIXI_HTTP_PORT         HTTP server port (default: 7777)
#   ZIXI_HLS_SEGMENT_SEC   HLS/CMAF segment duration in seconds (default: 6)
#   ZIXI_HLS_SEGMENTS      Segments kept in playlist (default: 6)
#   ZIXI_SKIP_RESTART      Set to 1 to skip service restart (not recommended)
set -euo pipefail

ZIXI_HOST="${ZIXI_HOST:-127.0.0.1}"
ZIXI_PORT="${ZIXI_PORT:-4444}"
ZIXI_USER="${ZIXI_USER:-admin}"
ZIXI_PASSWORD="${ZIXI_PASSWORD:-}"
ZIXI_STREAM_ID="${ZIXI_STREAM_ID:-benchmark}"
ZIXI_HTTP_PORT="${ZIXI_HTTP_PORT:-7777}"
ZIXI_HLS_SEGMENT_SEC="${ZIXI_HLS_SEGMENT_SEC:-6}"
ZIXI_HLS_SEGMENTS="${ZIXI_HLS_SEGMENTS:-6}"
ZIXI_SKIP_RESTART="${ZIXI_SKIP_RESTART:-0}"

if [[ -z "$ZIXI_PASSWORD" ]]; then
  echo "Set ZIXI_PASSWORD (Zixi admin password)." >&2
  exit 1
fi

BASE_URL="http://${ZIXI_HOST}:${ZIXI_PORT}"
AUTH=(-u "${ZIXI_USER}:${ZIXI_PASSWORD}")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ZIXI_JSON="${SCRIPT_DIR}/zixi_json.py"

zixi_get() {
  curl -sS "${AUTH[@]}" "$1"
}

zixi_call() {
  local url="$1"
  local response
  response="$(curl -sS "${AUTH[@]}" "$url")"
  if [[ "$response" == *"401 Unauthorized"* ]]; then
    echo "Zixi authentication failed for ${ZIXI_USER}@${ZIXI_HOST}:${ZIXI_PORT}" >&2
    exit 1
  fi
  if [[ "$response" == *"500 Internal Server Error"* ]]; then
    echo "Zixi API call failed: $url" >&2
    echo "$response" >&2
    return 1
  fi
  echo "$response"
}

parse_zixi_json() {
  python3 "$ZIXI_JSON"
}

stream_exists() {
  local target_id="$1"
  local streams_json
  streams_json="$(zixi_get "${BASE_URL}/zixi/streams.json?pagesize=500&page=0&metadata=0")"
  if [[ "$streams_json" == *"401 Unauthorized"* ]]; then
    echo "Zixi authentication failed for ${ZIXI_USER}@${ZIXI_HOST}:${ZIXI_PORT}" >&2
    exit 1
  fi
  TARGET_ID="$target_id" python3 - <<'PY' "$streams_json" "$ZIXI_JSON"
import json, os, subprocess, sys
text = sys.argv[1]
parser = sys.argv[2]
payload = json.loads(subprocess.check_output(["python3", parser], input=text, text=True))
target = os.environ["TARGET_ID"]
for stream in payload.get("streams", []):
    if stream.get("id") == target:
        sys.exit(0)
sys.exit(1)
PY
}

enable_live_recording() {
  local encoded_id
  encoded_id="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ZIXI_STREAM_ID")"
  echo "Enabling live recording for '${ZIXI_STREAM_ID}'..."
  zixi_call "${BASE_URL}/set_live_recording.json?func=hard_reload_inputs_table&id=${encoded_id}&on=1" >/dev/null
}

enable_http_hls_dash_origin() {
  echo "Enabling HTTP origin on port ${ZIXI_HTTP_PORT} (HLS + DASH, ${ZIXI_HLS_SEGMENT_SEC}s segments)..."
  zixi_call "${BASE_URL}/apply_settings.json?func=fill_server_settings_and_check_for_options\
&flv_on=0&hls_on=1&mpd_on=1&pls_on=0\
&http_out_ip=&http_out_port=${ZIXI_HTTP_PORT}\
&hls_chunk_time=${ZIXI_HLS_SEGMENT_SEC}&hls_chunks=${ZIXI_HLS_SEGMENTS}\
&http_auth_cahce_timeout=0&http_on=1&https_on=0&https_out_port=443\
&hls_dvr_duration_s=86400&hls_no_mem_chunks=0&hls_no_dvr=0&hls_vod_abs_path_on=0\
&http_ts_auto_in=1&http_ts_auto_out=0&http_ts_buffer_size=0&http_ts_smoothing_latency=0\
&tcp_congestion_algo=0\
&hls_playlist_http_cache_header_seconds=0&dash_playlist_http_cache_header_seconds=0\
&hls_media_http_cache_header_seconds=0&dash_media_http_cache_header_seconds=0\
&auto_hls_playback=1&auto_hls_playback_sub_gop_latency=0\
&ws_enabled=0&ws_port=8100&quic_enabled=0&quic_port=8080" >/dev/null
}

restart_zixi_if_needed() {
  if [[ "$ZIXI_SKIP_RESTART" == "1" ]]; then
    echo "Skipping Zixi restart (ZIXI_SKIP_RESTART=1)."
    return 0
  fi
  if [[ "$ZIXI_HOST" == "127.0.0.1" || "$ZIXI_HOST" == "localhost" ]]; then
    echo "Restarting local Zixi service..."
    sudo systemctl restart zixibc.service
    sleep 5
    return 0
  fi
  echo "Restarting remote Zixi service on ${ZIXI_HOST}..."
  ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no "ubuntu@${ZIXI_HOST}" \
    'sudo systemctl restart zixibc.service && sleep 5 && systemctl is-active zixibc.service'
}

echo "Configuring Zixi HLS/DASH origin at ${BASE_URL}"
echo "Stream ID: ${ZIXI_STREAM_ID}"
echo "HTTP TS push ingest: http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/${ZIXI_STREAM_ID}"
echo "HLS playback (live): http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/playback.m3u8?stream=${ZIXI_STREAM_ID}"
echo "DASH playback:       http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/${ZIXI_STREAM_ID}.mpd (may need adaptive group)"
echo ""

enable_http_hls_dash_origin
restart_zixi_if_needed

if stream_exists "$ZIXI_STREAM_ID"; then
  echo "Input '${ZIXI_STREAM_ID}' already exists — refreshing recording settings."
else
  echo "No input '${ZIXI_STREAM_ID}' found. Run configure-zixi-rtmp-input.sh first,"
  echo "or push once to create an automatic HTTP/RTMP input."
fi

enable_live_recording

echo ""
echo "Done. Verifying HLS output while stream is live..."
if [[ -x "$REPO_ROOT/infra/zixi/scripts/test-hls-dash-output.sh" ]]; then
  if ZIXI_HOST="$ZIXI_HOST" "$REPO_ROOT/infra/zixi/scripts/test-hls-dash-output.sh"; then
    echo ""
    echo "HLS origin is ready."
    echo "Web presets: moq_zixi_gcp_hls / moq_zixi_gcp_dash"
    exit 0
  fi
  echo ""
  echo "Configure step completed, but verification failed." >&2
  echo "Check Zixi UI (${BASE_URL}) → Settings → Live Protocols." >&2
  exit 1
fi

echo "Verify manually with:"
echo "  ./infra/zixi/scripts/test-hls-dash-output.sh"
