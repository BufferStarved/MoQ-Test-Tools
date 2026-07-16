#!/usr/bin/env bash
# Verify SRT push reaches Zixi "SRT Test" and advances HLS media_sequence.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
ZIXI_SRT_STREAM="${ZIXI_SRT_STREAM:-SRT Test}"
MEDIA="${MEDIA:-dummy.mp4}"
# Zixi HLS often needs ~25–30s of stable ingest before media_sequence rolls.
DURATION="${DURATION:-35}"
HLS_POLL_SECS="${HLS_POLL_SECS:-50}"

if [[ ! -f "$MEDIA" ]]; then
  echo "Media file not found: $MEDIA" >&2
  exit 1
fi

PYTHONPATH=src python3 - <<'PY' > /tmp/zixi-srt-url.txt
import os
from moq_publish import with_srt_stream_id
print(with_srt_stream_id("srt://35.222.33.58:10080?mode=caller&latency=200000", "SRT Test"))
PY
SRT_URL="$(tr -d '\n' < /tmp/zixi-srt-url.txt)"
STREAMID_MODE="${ZIXI_SRT_STREAMID_MODE:-access}"
HLS_URL="http://${ZIXI_HOST}:7777/playback.m3u8?stream=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${ZIXI_SRT_STREAM}'))")"
MPEGTS_BSF="$(PYTHONPATH=src python3 -c 'from moq_publish import MPEGTS_VIDEO_BSF; print(MPEGTS_VIDEO_BSF)')"

echo "streamid mode: ${STREAMID_MODE}"
echo "SRT push URL: ${SRT_URL}"
echo "HLS watch:    ${HLS_URL}"
echo "push mode:    ffmpeg direct → SRT (stable; avoids srt-live-transmit reconnect churn)"
echo ""

read_hls_sequence() {
  curl -sf "$HLS_URL" 2>/dev/null | awk -F: '/EXT-X-MEDIA-SEQUENCE/ {print $2}' | tr -d '\r' || true
}

read_hls_chunk() {
  curl -sf "$HLS_URL" 2>/dev/null | awk -F'chunk=' '/chunk=/ {print $2}' | awk -F'&' '{print $1}' | tr -d '\r' | tail -1 || true
}

seq_before="$(read_hls_sequence)"
chunk_before="$(read_hls_chunk)"
echo "HLS media_sequence before push: ${seq_before:-unknown}"
echo "HLS chunk before push:          ${chunk_before:-unknown}"

FFMPEG="${FFMPEG:-ffmpeg}"
if [[ -x "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" ]]; then
  FFMPEG="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
fi
if ! "$FFMPEG" -protocols 2>/dev/null | grep -qw srt; then
  echo "ffmpeg lacks SRT support. Install: brew install ffmpeg-full" >&2
  exit 1
fi

echo "Pushing ${DURATION}s via ffmpeg → SRT ..."
FFMPEG_LOG="/tmp/zixi-ffmpeg-verify.log"
POLL_FLAG="/tmp/zixi-hls-advanced.flag"
rm -f "$POLL_FLAG"

poll_hls_sequence() {
  local before="$1"
  local chunk_start="$2"
  local end=$((SECONDS + HLS_POLL_SECS))
  local n=0
  while (( SECONDS < end )); do
    n=$((n + 1))
    local seq chunk
    seq="$(read_hls_sequence)"
    chunk="$(read_hls_chunk)"
    echo "HLS poll ${n}: media_sequence=${seq:-<none>} chunk=${chunk:-<none>}"
    if [[ -n "$before" && -n "$seq" && "$seq" != "$before" ]]; then
      echo "$seq" > /tmp/zixi-hls-seq-after.txt
      : >"$POLL_FLAG"
      return 0
    fi
    if [[ -n "$chunk_start" && -n "$chunk" && "$chunk" != "$chunk_start" ]]; then
      echo "${seq:-$before}" > /tmp/zixi-hls-seq-after.txt
      : >"$POLL_FLAG"
      return 0
    fi
    sleep 2
  done
  read_hls_sequence > /tmp/zixi-hls-seq-after.txt || true
}

poll_hls_sequence "$seq_before" "$chunk_before" &
POLL_PID=$!

set +e
"$FFMPEG" -hide_banner -loglevel warning -re -i "$MEDIA" -t "$DURATION" \
  -map 0:v:0 -map 0:a:0? \
  -c:v libx264 -pix_fmt yuv420p -b:v 2500k -maxrate 2800k -bufsize 5600k \
  -g 60 -keyint_min 60 -sc_threshold 0 -bf 0 \
  -x264-params repeat-headers=1 \
  -c:a aac -b:a 128k \
  -bsf:v "$MPEGTS_BSF" \
  -f mpegts "$SRT_URL" >"$FFMPEG_LOG" 2>&1
FFMPEG_CODE=$?
set -e

if [[ "$FFMPEG_CODE" -ne 0 ]]; then
  echo "[FAIL] ffmpeg exited $FFMPEG_CODE — no MPEG-TS sent."
  tail -5 "$FFMPEG_LOG"
  kill "$POLL_PID" 2>/dev/null || true
  wait "$POLL_PID" 2>/dev/null || true
  exit 1
fi

wait "$POLL_PID" 2>/dev/null || true
seq_after="$(tr -d '\n' < /tmp/zixi-hls-seq-after.txt 2>/dev/null || true)"
echo "HLS media_sequence after push:  ${seq_after:-unknown}"

if [[ -f "$POLL_FLAG" ]]; then
  echo "[PASS] Zixi HLS advanced (${seq_before}→${seq_after}) — SRT ingest + HLS packaging OK."
  exit 0
fi

echo "[FAIL] HLS did not advance in ${HLS_POLL_SECS}s."
echo "If Zixi UI shows Connected + packets during push, ingest (L2) is OK — fix L3:"
echo "  Settings → Live Protocols → HTTP :7777 + HLS enabled, then restart Zixi."
exit 1
