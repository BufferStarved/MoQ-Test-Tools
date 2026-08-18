#!/usr/bin/env bash
# Drop Blender's Creative Commons Big Buck Bunny next to dummy.mp4 for cloud playout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BBB_DEST:-$ROOT/bbb.mp4}"
# Wikimedia 1080p VP9 (~287 MB), sunflower cut, CC BY Blender Foundation.
# Google's old gtv-videos-bucket copy now 403s. Override with BBB_URL.
URL="${BBB_URL:-https://upload.wikimedia.org/wikipedia/commons/transcoded/c/c0/Big_Buck_Bunny_4K.webm/Big_Buck_Bunny_4K.webm.1080p.vp9.webm}"

mkdir -p "$(dirname "$DEST")"
if [[ -s "$DEST" ]]; then
  echo "Already present: $DEST ($(du -h "$DEST" | awk '{print $1}'))"
  exit 0
fi

tmp="${DEST}.part"
echo "Downloading Big Buck Bunny → $DEST"
if command -v curl >/dev/null 2>&1; then
  curl -L --fail --retry 3 --progress-bar -o "$tmp" "$URL"
else
  python3 - "$URL" "$tmp" <<'PY'
import sys, urllib.request
urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
PY
fi

# Wikimedia payload is WebM/VP9. Remux to MP4 + AAC so ffmpeg's usual MP4
# demuxer and downmix paths match dummy.mp4. Falls back to the raw download.
if command -v ffmpeg >/dev/null 2>&1 && file -b "$tmp" | grep -qi 'webm\|matroska'; then
  echo "Remuxing VP9/WebM → MP4 (copy video, AAC audio)..."
  remux="${DEST}.remux.mp4"
  ffmpeg -y -hide_banner -loglevel error -i "$tmp" -c:v copy -c:a aac -b:a 160k -movflags +faststart "$remux"
  rm -f "$tmp"
  mv "$remux" "$DEST"
else
  mv "$tmp" "$DEST"
fi
echo "Saved $DEST ($(du -h "$DEST" | awk '{print $1}'))"
