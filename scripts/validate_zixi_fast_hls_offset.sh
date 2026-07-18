#!/usr/bin/env bash
# Dual-publish smoke: two file publishes into the same Zixi SRT input WITHOUT
# delete+recreate should keep Fast HLS advancing when -output_ts_offset is applied.
#
# Usage (from a machine with ffmpeg + network to Zixi):
#   ZIXI_HOST=35.222.33.58 STREAM_ID='SRT Test' ./scripts/validate_zixi_fast_hls_offset.sh [media.mp4]
#
# Expectation: second publish's playlist media_sequence / segment URI changes within ~15s.
set -euo pipefail

ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
STREAM_ID="${STREAM_ID:-SRT Test}"
MEDIA="${1:-dummy.mp4}"
DURATION="${DURATION:-20}"
STEP="${STEP:-300}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export STREAM_ID ZIXI_HOST

if [[ ! -f "$MEDIA" ]]; then
  echo "Media not found: $MEDIA" >&2
  exit 2
fi

FFMPEG="${FFMPEG:-}"
if [[ -z "$FFMPEG" ]]; then
  for candidate in \
    /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
    /usr/local/opt/ffmpeg-full/bin/ffmpeg \
    /usr/local/bin/ffmpeg \
    ffmpeg
  do
    if command -v "$candidate" >/dev/null 2>&1 || [[ -x "$candidate" ]]; then
      if "$candidate" -protocols 2>/dev/null | grep -qw srt; then
        FFMPEG="$candidate"
        break
      fi
      # Prefer any ffmpeg; may pair with srt-live-transmit below.
      [[ -z "$FFMPEG" ]] && FFMPEG="$candidate"
    fi
  done
fi
SRT_BIN="${SRT_BIN:-$(command -v srt-live-transmit || true)}"

STATE="$(mktemp)"
export ZIXI_TS_OFFSET_STATE="$STATE"
export ZIXI_OUTPUT_TS_OFFSET=1
export ZIXI_TS_OFFSET_STEP_FLOOR="$STEP"
export ZIXI_SRT_RESET_BEFORE_PUBLISH=0

# Seed the counter so publish #1 clears any stale Fast HLS high-water mark from
# prior lab sessions (fresh temp state would otherwise start at offset 0).
SEED_INDEX="${SEED_INDEX:-}"
if [[ -z "$SEED_INDEX" ]]; then
  SEED_INDEX="$(python3 -c "import time; print(int(time.time()) % 200)")"
fi
PYTHONPATH=src python3 - <<PY
import json, os
from pathlib import Path
path = Path(os.environ["ZIXI_TS_OFFSET_STATE"])
path.write_text(json.dumps({os.environ["STREAM_ID"]: int("${SEED_INDEX}")}) + "\n")
print(f"Seeded offset index={int('${SEED_INDEX}')} (first offset≈{int('${SEED_INDEX}')*int('${STEP}')}s)")
PY

SRT_URL="$(
  PYTHONPATH=src python3 - <<'PY'
import os
from moq_publish import with_srt_stream_id
from encode_profile import with_srt_latency
host = os.environ.get("ZIXI_HOST", "35.222.33.58")
stream = os.environ["STREAM_ID"]
url = f"srt://{host}:10080?mode=caller&latency=200000"
print(with_srt_latency(with_srt_stream_id(url, stream), 200))
PY
)"
PLAYLIST="http://${ZIXI_HOST}:7777/playback.m3u8?stream=$(
  python3 -c 'import urllib.parse,os; print(urllib.parse.quote(os.environ["STREAM_ID"], safe=""))'
)"

probe_playlist() {
  curl -fsS --max-time 5 "$PLAYLIST" 2>/dev/null | head -n 40 || true
}

pick_udp_port() {
  python3 - <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

publish_once() {
  local offset
  offset="$(
    PYTHONPATH=src python3 - <<PY
from zixi_ts_offset import allocate_output_ts_offset
print(allocate_output_ts_offset("${STREAM_ID}", duration_sec=${DURATION}))
PY
  )"
  echo "Publishing with output_ts_offset=${offset} for ${DURATION}s (ffmpeg=${FFMPEG})"
  local -a offset_args=()
  if python3 -c "import sys; sys.exit(0 if float('${offset}') > 0 else 1)"; then
    offset_args=(-output_ts_offset "$offset")
  fi

  if [[ -n "$SRT_BIN" ]]; then
    local port udp
    port="$(pick_udp_port)"
    udp="udp://127.0.0.1:${port}?pkt_size=1316"
    "$SRT_BIN" "udp://:@127.0.0.1:${port}" "$SRT_URL" >/tmp/mtx_val_srt.log 2>&1 &
    local srt_pid=$!
    sleep 0.4
    "$FFMPEG" -hide_banner -loglevel warning -re -t "$DURATION" -i "$MEDIA" \
      -c:v libx264 -preset veryfast -tune zerolatency -g 60 -keyint_min 60 \
      -c:a aac -b:a 128k \
      ${offset_args[@]+"${offset_args[@]}"} \
      -bsf:v h264_mp4toannexb -f mpegts "$udp" || true
    kill "$srt_pid" 2>/dev/null || true
    wait "$srt_pid" 2>/dev/null || true
  else
    "$FFMPEG" -hide_banner -loglevel warning -re -t "$DURATION" -i "$MEDIA" \
      -c:v libx264 -preset veryfast -tune zerolatency -g 60 -keyint_min 60 \
      -c:a aac -b:a 128k \
      ${offset_args[@]+"${offset_args[@]}"} \
      -bsf:v h264_mp4toannexb -f mpegts "$SRT_URL" || true
  fi
}

echo "Playlist before: $PLAYLIST"
probe_playlist | sed -n '1,20p' || true
publish_once
sleep 2
FIRST="$(probe_playlist)"
echo "--- after publish 1 ---"
echo "$FIRST" | sed -n '1,25p'
publish_once
sleep 3
SECOND="$(probe_playlist)"
echo "--- after publish 2 ---"
echo "$SECOND" | sed -n '1,25p'

SEQ1="$(echo "$FIRST" | sed -n 's/^#EXT-X-MEDIA-SEQUENCE://p' | head -1)"
SEQ2="$(echo "$SECOND" | sed -n 's/^#EXT-X-MEDIA-SEQUENCE://p' | head -1)"
CHUNK1="$(echo "$FIRST" | grep -E 'chunk=' | head -1 || true)"
CHUNK2="$(echo "$SECOND" | grep -E 'chunk=' | head -1 || true)"
echo "media_sequence publish1=${SEQ1:-?} publish2=${SEQ2:-?}"
echo "segment publish1=${CHUNK1:-?}"
echo "segment publish2=${CHUNK2:-?}"
if [[ -n "${SEQ1:-}" && -n "${SEQ2:-}" && "$SEQ2" != "$SEQ1" ]]; then
  echo "PASS: playlist advanced across republish without input recreate."
  exit 0
fi
if [[ -n "$CHUNK1" && -n "$CHUNK2" && "$CHUNK1" != "$CHUNK2" ]]; then
  echo "PASS: segment URI changed across republish without input recreate."
  exit 0
fi
if [[ "$FIRST" != "$SECOND" && -n "$SECOND" ]]; then
  echo "PASS: playlist body changed across republish (sequence tags may be absent)."
  exit 0
fi
echo "FAIL: playlist did not clearly advance. Check offset / Zixi logs." >&2
exit 1
