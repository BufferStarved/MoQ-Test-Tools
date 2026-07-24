#!/usr/bin/env bash
# Verify (and optionally re-apply) Zixi Fast HLS chunk duration.
#
# Zixi only cuts Fast HLS on IDRs; hls_chunk_time must stay at the 2s floor
# our encode GOP + hls.js liveSync are tuned for. A leftover 4s chunk_time
# from the old GOP=latency-budget era silently restores ~15s+ join/e2e.
#
# Usage:
#   ZIXI_PASSWORD=... ./infra/zixi/scripts/verify-zixi-hls-chunk-time.sh
#   ZIXI_PASSWORD=... ZIXI_FIX=1 ./infra/zixi/scripts/verify-zixi-hls-chunk-time.sh
#
# Environment mirrors configure-zixi-hls-dash-output.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
ZIXI_PORT="${ZIXI_PORT:-4444}"
ZIXI_USER="${ZIXI_USER:-admin}"
ZIXI_PASSWORD="${ZIXI_PASSWORD:-}"
ZIXI_HTTP_PORT="${ZIXI_HTTP_PORT:-7777}"
EXPECTED_SEC="${ZIXI_HLS_SEGMENT_SEC:-2}"
ZIXI_FIX="${ZIXI_FIX:-0}"

if [[ -z "$ZIXI_PASSWORD" && "$ZIXI_FIX" == "1" ]]; then
  echo "ZIXI_PASSWORD is required to re-apply settings (ZIXI_FIX=1)." >&2
  exit 2
fi

if [[ "$EXPECTED_SEC" -lt 2 ]]; then
  echo "ZIXI_HLS_SEGMENT_SEC=${EXPECTED_SEC} is below the 2s minimum; clamping to 2." >&2
  EXPECTED_SEC=2
fi

BASE_URL="http://${ZIXI_HOST}:${ZIXI_PORT}"

# Probe a live playlist's EXT-X-TARGETDURATION (no auth). Empty/offline → skip.
probe_targetduration() {
  local stream="${1:-benchmark}"
  local body
  body="$(curl -fsS --max-time 5 \
    "http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/playback.m3u8?stream=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$stream")" \
    2>/dev/null || true)"
  if [[ -z "$body" || "$body" != *"#EXTM3U"* ]]; then
    echo "playlist: offline or empty (stream=${stream}) — cannot read TARGETDURATION"
    return 1
  fi
    local td
    td="$(printf '%s\n' "$body" | sed -n 's/^#EXT-X-TARGETDURATION:\([0-9][0-9]*\).*/\1/p' | head -1)"
    local extinf
    extinf="$(printf '%s\n' "$body" | sed -n 's/^#EXTINF:\([0-9][0-9]*\).*/\1/p' | head -1)"
    if [[ -z "$td" && -z "$extinf" ]]; then
      echo "playlist: no EXT-X-TARGETDURATION / EXTINF"
      return 1
    fi
    echo "playlist TARGETDURATION=${td:-?}s EXTINF=${extinf:-?}s (stream=${stream})"
    # Zixi with -output_ts_offset can advertise a huge TARGETDURATION while
    # EXTINF stays at the real chunk size — trust EXTINF when present.
    local chunk="${extinf:-$td}"
    if [[ -n "$extinf" && -n "$td" && "$td" -gt 10 && "$extinf" -le 6 ]]; then
      echo "NOTE: TARGETDURATION=${td}s looks inflated; using EXTINF=${extinf}s as chunk size."
      chunk="$extinf"
    fi
    if [[ "$chunk" -gt "$EXPECTED_SEC" ]]; then
      echo "FAIL: chunk ${chunk}s > expected ${EXPECTED_SEC}s — Fast HLS chunks are too long." >&2
      return 2
    fi
    if [[ "$chunk" -lt 2 ]]; then
      echo "WARN: chunk ${chunk}s is below the 2s floor (may stutter)." >&2
    fi
    echo "OK: chunk duration within policy (floor=2s, expected<=${EXPECTED_SEC}s)"
    return 0
}

echo "Checking Zixi Fast HLS chunk policy on ${ZIXI_HOST} (expected ${EXPECTED_SEC}s)..."
rc=1
for stream in benchmark "SRT Test" "SRT Test EC"; do
  set +e
  probe_targetduration "$stream"
  rc=$?
  set -e
  if [[ "$rc" -ne 1 ]]; then
    break
  fi
done

if [[ "$rc" -eq 2 || "$ZIXI_FIX" == "1" ]]; then
  echo "Re-applying hls_chunk_time=${EXPECTED_SEC} via configure-zixi-hls-dash-output.sh..."
  ZIXI_HOST="$ZIXI_HOST" ZIXI_PORT="$ZIXI_PORT" ZIXI_USER="$ZIXI_USER" \
    ZIXI_PASSWORD="$ZIXI_PASSWORD" ZIXI_HLS_SEGMENT_SEC="$EXPECTED_SEC" \
    "$ROOT/infra/zixi/scripts/configure-zixi-hls-dash-output.sh"
  echo "Re-check after configure (input must be publishing for TARGETDURATION)..."
  probe_targetduration "benchmark" || probe_targetduration "SRT Test" || true
  exit 0
fi

if [[ "$rc" -eq 1 ]]; then
  echo "No live playlist — Broadcaster settings were not read from the wire."
  echo "To force hls_chunk_time=${EXPECTED_SEC}: ZIXI_FIX=1 $0"
  exit 0
fi

exit "$rc"
