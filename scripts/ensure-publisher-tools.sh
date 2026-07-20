#!/usr/bin/env bash
# Best-effort install of srt-live-transmit + openmoq-publisher for local publisher agents.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "Ensuring publisher tools…"

if ! command -v srt-live-transmit >/dev/null 2>&1 \
  && [[ ! -x /opt/homebrew/bin/srt-live-transmit ]] \
  && [[ ! -x /usr/local/bin/srt-live-transmit ]]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing srt via Homebrew…"
    brew install srt || true
  else
    echo "WARNING: srt-live-transmit not found and Homebrew unavailable."
    echo "  Linux: sudo apt-get install -y srt-tools   (package name varies)"
  fi
else
  echo "srt-live-transmit: ok"
fi

PUB="$ROOT_DIR/tools/openmoq-publisher/bin/openmoq-publisher"
if [[ ! -x "$PUB" ]] && ! command -v openmoq-publisher >/dev/null 2>&1; then
  echo "Installing openmoq-publisher…"
  bash "$ROOT_DIR/scripts/install-openmoq-publisher.sh" </dev/null || true
else
  echo "openmoq-publisher: ok"
fi

if [[ ! -x "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" ]] \
  && [[ -z "${FFMPEG:-}" ]] \
  && ! command -v ffmpeg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Installing ffmpeg-full via Homebrew…"
    brew install ffmpeg-full || brew install ffmpeg || true
  else
    echo "WARNING: ffmpeg not found. Install a build with libx264."
  fi
else
  echo "ffmpeg: ok"
fi

echo "Publisher tools check complete."
