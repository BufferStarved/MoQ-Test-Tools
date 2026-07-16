#!/usr/bin/env bash
# End-to-end test: ingest live stream → verify Zixi HLS/DASH origin playback.
#
# Zixi per-input HLS is served at:
#   http://<host>:7777/playback.m3u8?stream=<stream-id>
# while the stream is live (not at /<stream-id>.m3u8).
#
# DASH may require an adaptive group; we still probe /<stream-id>.mpd as a best effort.
set -euo pipefail

ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
ZIXI_HTTP_PORT="${ZIXI_HTTP_PORT:-7777}"
ZIXI_RTMP_PORT="${ZIXI_RTMP_PORT:-1935}"
ZIXI_STREAM_ID="${ZIXI_STREAM_ID:-benchmark}"
PUSH_SEC="${PUSH_SEC:-18}"
WAIT_SEC="${WAIT_SEC:-20}"
REQUIRE_DASH="${REQUIRE_DASH:-0}"

FFMPEG="${FFMPEG:-ffmpeg}"
if [[ -x "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" ]]; then
  FFMPEG="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
fi

MEDIA="${MEDIA:-dummy.mp4}"
if [[ ! -f "$MEDIA" ]]; then
  MEDIA="$(cd "$(dirname "$0")/../../.." && pwd)/dummy.mp4"
fi

INGEST_RTMP_URL="rtmp://${ZIXI_HOST}:${ZIXI_RTMP_PORT}/live/${ZIXI_STREAM_ID}"
INGEST_HTTP_URL="http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/${ZIXI_STREAM_ID}"
HLS_URL="http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/playback.m3u8?stream=${ZIXI_STREAM_ID}"
DASH_URL="http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/${ZIXI_STREAM_ID}.mpd"
DASH_PREVIEW_URL="http://${ZIXI_HOST}:${ZIXI_HTTP_PORT}/playback.mpd?stream=${ZIXI_STREAM_ID}"

echo "Zixi HLS/DASH output test"
echo "  Ingest (RTMP): ${INGEST_RTMP_URL}"
echo "  Ingest (HTTP): ${INGEST_HTTP_URL}"
echo "  HLS playback:  ${HLS_URL}"
echo "  DASH playback: ${DASH_URL}"
echo ""

check_manifest() {
  local label="$1"
  local url="$2"
  local pattern="$3"
  local code body
  code="$(curl -s -o /tmp/zixi_manifest_body -w "%{http_code}" --connect-timeout 5 "$url" || true)"
  body="$(cat /tmp/zixi_manifest_body 2>/dev/null || true)"
  if [[ "$code" == "200" ]] && echo "$body" | grep -q "$pattern"; then
    echo "OK   ${label} (${code})"
    return 0
  fi
  echo "FAIL ${label} (${code})"
  if [[ -n "$body" ]]; then
    echo "     $(echo "$body" | tr '\n' ' ' | head -c 160)"
  fi
  return 1
}

echo "Pushing ${PUSH_SEC}s via RTMP (reliable; HTTP PUT hangs until server closes)..."
"$FFMPEG" -hide_banner -loglevel warning -re -i "$MEDIA" -c:v copy -c:a copy -t "$PUSH_SEC" \
  -f flv -flvflags no_duration_filesize "$INGEST_RTMP_URL" >/tmp/zixi_hls_dash_push.log 2>&1 &
FFMPEG_PID=$!

echo "Waiting for live HLS/DASH manifests while stream is active..."
deadline=$(( $(date +%s) + WAIT_SEC ))
hls_ok=1
dash_ok=1
while kill -0 "$FFMPEG_PID" 2>/dev/null || [[ $(date +%s) -lt $deadline ]]; do
  if [[ $hls_ok -ne 0 ]] && check_manifest "HLS playlist" "$HLS_URL" "#EXTM3U"; then
    hls_ok=0
  fi
  if [[ $dash_ok -ne 0 ]]; then
    if check_manifest "DASH manifest" "$DASH_URL" "<MPD"; then
      dash_ok=0
    elif check_manifest "DASH preview" "$DASH_PREVIEW_URL" "<MPD"; then
      dash_ok=0
    fi
  fi
  if [[ $hls_ok -eq 0 ]]; then
    if [[ "$REQUIRE_DASH" != "1" ]]; then
      break
    fi
    if [[ $dash_ok -eq 0 ]]; then
      break
    fi
  fi
  if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
    break
  fi
  sleep 2
done

wait "$FFMPEG_PID" 2>/dev/null || true
echo ""

if [[ $hls_ok -ne 0 ]]; then
  echo "HLS playlist not ready at ${HLS_URL}" >&2
  echo "Note: Zixi does NOT serve per-input HLS at /${ZIXI_STREAM_ID}.m3u8" >&2
fi
if [[ $dash_ok -ne 0 && "$REQUIRE_DASH" == "1" ]]; then
  echo "DASH manifest not ready at ${DASH_URL}" >&2
fi

if [[ $hls_ok -eq 0 && ( "$REQUIRE_DASH" != "1" || $dash_ok -eq 0 ) ]]; then
  echo ""
  if [[ $dash_ok -eq 0 ]]; then
    echo "SUCCESS: HLS and DASH outputs are available."
  else
    echo "SUCCESS: HLS output is available."
    echo "WARN: DASH manifest was not found. Per-input DASH may require an adaptive group in Zixi."
  fi
  exit 0
fi

echo "" >&2
echo "FAILED: ensure Live Protocols has HTTP+HLS enabled and Zixi was restarted after saving:" >&2
echo "  ZIXI_HOST=${ZIXI_HOST} ZIXI_PASSWORD=... ./infra/zixi/scripts/configure-zixi-hls-dash-output.sh" >&2
exit 1
