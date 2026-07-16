#!/usr/bin/env bash
# Test connectivity to a Zixi ingest endpoint before running a benchmark.
set -euo pipefail

URL="${1:-}"
if [[ -z "$URL" ]]; then
  cat <<EOF
Usage: $0 <endpoint-url>

Examples:
  $0 'srt://35.222.33.58:10080?mode=caller&latency=200000'
  $0 'rtmp://35.222.33.58:1935/live/benchmark'
  $0 'http://35.222.33.58:7777/benchmark'
EOF
  exit 1
fi

FFMPEG="${FFMPEG:-ffmpeg}"
if [[ -x "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" ]]; then
  FFMPEG="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
fi

MEDIA="${MEDIA:-dummy.mp4}"
if [[ ! -f "$MEDIA" ]]; then
  MEDIA="$(cd "$(dirname "$0")/../../.." && pwd)/dummy.mp4"
fi

echo "Using ffmpeg: $FFMPEG"
if ! "$FFMPEG" -protocols 2>/dev/null | grep -qw srt; then
  echo "WARN: ffmpeg may lack SRT support. Install: brew install ffmpeg-full"
fi

HOST_PORT="$(python3 - <<'PY' "$URL"
import sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
default_port = {
    "rtmp": "1935",
    "http": "7777",
    "https": "443",
}.get(u.scheme, "2088")
print(f"{u.hostname}:{u.port or default_port}")
PY
)"

HOST="${HOST_PORT%%:*}"
PORT="${HOST_PORT##*:}"

echo ""
echo "Endpoint: $URL"
echo "Host: $HOST  Port: $PORT"
echo ""

echo "Port checks:"
nc -zv -G 3 "$HOST" "$PORT" 2>&1 || true
nc -zvu -G 3 "$HOST" "$PORT" 2>&1 || true
curl -s -o /dev/null -w "Zixi UI (4444): HTTP %{http_code}\n" --connect-timeout 3 "http://${HOST}:4444/login.html" || true

echo ""
echo "ffmpeg 3-second test push:"
set +e
OUTPUT="$("$FFMPEG" -hide_banner -loglevel warning -re -i "$MEDIA" -c:v copy -c:a copy -t 3 \
  $(python3 - <<'PY' "$URL"
import sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
if u.scheme == "rtmp":
    print("-f flv -flvflags no_duration_filesize", sys.argv[1])
elif u.scheme in {"http", "https"}:
    print("-f mpegts -method PUT", sys.argv[1])
else:
    print("-f mpegts", sys.argv[1])
PY
) 2>&1)"
CODE=$?
set -e

if [[ $CODE -eq 0 ]]; then
  echo "SUCCESS: ffmpeg connected and pushed for 3 seconds."
  exit 0
fi

echo "$OUTPUT" | tail -5
echo ""
echo "FAILED (exit $CODE)."
echo ""
echo "If Zixi UI loads but ffmpeg fails, the ingest input is not online."
echo "In Zixi (http://${HOST}:4444):"
echo "  1. Status page -> confirm license is ACTIVE"
echo "  2. Inputs -> input must be ONLINE (not offline / failed to bind)"
echo "  3. SRT: use port 10080 or 9000 (NOT 2088 - reserved by Zixi)"
echo "  4. RTMP Push: Zixi stream ID is the stream key (e.g. benchmark for rtmp://host/live/benchmark)
echo "  5. HTTP TS push: push to http://host:7777/benchmark (Stream ID = path segment)""
