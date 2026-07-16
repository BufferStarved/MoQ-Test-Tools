#!/usr/bin/env bash
# Configure an RTMP push input on Zixi Broadcaster (mirrors the SRT ingest setup).
#
# Creates a push input whose Stream ID matches the ffmpeg URL path, enables live
# recording for VMAF, and ensures the RTMP server is listening.
#
# Usage:
#   ZIXI_PASSWORD=... ./infra/zixi/scripts/configure-zixi-rtmp-input.sh
#   ZIXI_HOST=35.222.33.58 ZIXI_PASSWORD=... ./infra/zixi/scripts/configure-zixi-rtmp-input.sh
#
# Environment:
#   ZIXI_HOST          Zixi UI host (default: 127.0.0.1)
#   ZIXI_PORT          Zixi UI port (default: 4444)
#   ZIXI_USER          Admin username (default: admin)
#   ZIXI_PASSWORD      Admin password (required)
#   ZIXI_STREAM_ID     RTMP stream ID (default: benchmark)
#   ZIXI_RTMP_PORT     RTMP server port (default: 1935)
set -euo pipefail

ZIXI_HOST="${ZIXI_HOST:-127.0.0.1}"
ZIXI_PORT="${ZIXI_PORT:-4444}"
ZIXI_USER="${ZIXI_USER:-admin}"
ZIXI_PASSWORD="${ZIXI_PASSWORD:-}"
ZIXI_STREAM_ID="${ZIXI_STREAM_ID:-benchmark}"
ZIXI_RTMP_PORT="${ZIXI_RTMP_PORT:-1935}"

if [[ -z "$ZIXI_PASSWORD" ]]; then
  echo "Set ZIXI_PASSWORD (Zixi admin password)." >&2
  exit 1
fi

BASE_URL="http://${ZIXI_HOST}:${ZIXI_PORT}"
AUTH=(-u "${ZIXI_USER}:${ZIXI_PASSWORD}")
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

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

stream_exists() {
  local target_id="$1"
  local streams_json
  streams_json="$(zixi_get "${BASE_URL}/zixi/streams.json?pagesize=500&page=0&metadata=0")"
  if [[ "$streams_json" == *"401 Unauthorized"* ]]; then
    echo "Zixi authentication failed for ${ZIXI_USER}@${ZIXI_HOST}:${ZIXI_PORT}" >&2
    exit 1
  fi
  TARGET_ID="$target_id" python3 - <<'PY' "$streams_json"
import json, os, sys
payload = json.loads(sys.argv[1])
target = os.environ["TARGET_ID"]
for stream in payload.get("streams", []):
    if stream.get("id") == target:
        sys.exit(0)
sys.exit(1)
PY
}

remove_stream_if_exists() {
  local target_id="$1"
  if ! stream_exists "$target_id"; then
    return 0
  fi
  local encoded_id
  encoded_id="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$target_id")"
  echo "Removing stale input '${target_id}'..."
  zixi_call "${BASE_URL}/zixi/remove_stream.json?id=${encoded_id}" >/dev/null || true
}

enable_rtmp_server() {
  echo "Ensuring RTMP server is enabled on port ${ZIXI_RTMP_PORT}..."
  zixi_call "${BASE_URL}/apply_settings.json?func=fill_server_settings_and_check_for_options\
&rtmp_on=1&rtmp_port=${ZIXI_RTMP_PORT}&rtmp_auto_out=0&rtmp_auto_in=0&rtmp_pcr_int=90&rtmp_auto_out_latency=0" >/dev/null
}

add_rtmp_push_input() {
  local encoded_id
  encoded_id="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ZIXI_STREAM_ID")"
  local encoded_template
  encoded_template="$(python3 -c 'import urllib.parse; print(urllib.parse.quote("%S_%Y%M%D-%T.ts"))')"

  echo "Adding RTMP push input '${ZIXI_STREAM_ID}'..."
  zixi_call "${BASE_URL}/zixi/add_stream.json?func=load_live_inputs&type=rtmp_push\
&id=${encoded_id}&matrix=1&support_scte=0&support_scte_pid=AUTO&support_scte_cleanup=0&support_scte_timeout=\
&log_this_stream=0&metadata=0&analyze=0&max_outputs=-1&latency_offset=0\
&fast-connect=0&kompression=1\
&rec_duration=7200&rec_template=${encoded_template}&s3=0&rec_history=0&rec_path=\
&rtmp_url=&rtmp_name=&rtmp_user=&rtmp_bitrate=0&rtmp_latency=0&disconnect_low_br=1&rtmp_max_bitrate=0&cert=1&nic=" >/dev/null
}

enable_live_recording() {
  local encoded_id
  encoded_id="$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$ZIXI_STREAM_ID")"
  echo "Enabling live recording for '${ZIXI_STREAM_ID}'..."
  zixi_call "${BASE_URL}/set_live_recording.json?func=hard_reload_inputs_table&id=${encoded_id}&on=1" >/dev/null
}

echo "Configuring Zixi RTMP ingest at ${BASE_URL}"
echo "Stream ID: ${ZIXI_STREAM_ID}"
echo "RTMP URL:  rtmp://${ZIXI_HOST}:${ZIXI_RTMP_PORT}/live/${ZIXI_STREAM_ID}"
echo ""

enable_rtmp_server

# A common misconfiguration uses stream ID live/benchmark instead of benchmark.
remove_stream_if_exists "live/benchmark"

if stream_exists "$ZIXI_STREAM_ID"; then
  echo "Input '${ZIXI_STREAM_ID}' already exists — refreshing recording settings."
else
  add_rtmp_push_input
fi

enable_live_recording

echo ""
echo "Done. Verifying RTMP publish..."
if [[ -x "$REPO_ROOT/infra/zixi/scripts/test-endpoint.sh" ]]; then
  if ZIXI_HOST="$ZIXI_HOST" "$REPO_ROOT/infra/zixi/scripts/test-endpoint.sh" \
    "rtmp://${ZIXI_HOST}:${ZIXI_RTMP_PORT}/live/${ZIXI_STREAM_ID}"; then
    echo ""
    echo "RTMP ingest is ready. Web preset: moq_zixi_gcp_rtmp"
    exit 0
  fi
  echo ""
  echo "Configure step completed, but ffmpeg verification failed." >&2
  echo "Check Zixi UI (${BASE_URL}) and confirm input '${ZIXI_STREAM_ID}' is ONLINE." >&2
  exit 1
fi

echo "Verify manually with:"
echo "  ./infra/zixi/scripts/test-endpoint.sh 'rtmp://${ZIXI_HOST}:${ZIXI_RTMP_PORT}/live/${ZIXI_STREAM_ID}'"
echo ""
echo "Web UI preset: moq_zixi_gcp_rtmp"
