#!/usr/bin/env bash
# Install srt-live-transmit, openmoq-publisher, and an ffmpeg that can
# mux `-f whip`. The clone/run paste command must leave a working agent —
# do not treat a stock ffmpeg without WHIP as "ok".
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.publisher-tools.env"

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

ffmpeg_has_whip() {
  local bin="$1"
  [[ -n "$bin" && -x "$bin" ]] || return 1
  "$bin" -hide_banner -muxers 2>/dev/null | grep -qE '^[[:space:]]*E[[:space:]]+whip'
}

find_whip_ffmpeg() {
  local bin
  for bin in \
    "${FFMPEG:-}" \
    /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
    /usr/local/opt/ffmpeg-full/bin/ffmpeg \
    /opt/homebrew/bin/ffmpeg \
    /usr/local/bin/ffmpeg \
    "$(command -v ffmpeg || true)"; do
    if ffmpeg_has_whip "$bin"; then
      printf '%s' "$bin"
      return 0
    fi
  done
  return 1
}

write_ffmpeg_env() {
  local bin="$1"
  local dir
  dir="$(cd "$(dirname "$bin")" && pwd)"
  cat > "$ENV_FILE" <<EOF
export FFMPEG="$bin"
export PATH="$dir:\$PATH"
EOF
}

install_whip_ffmpeg() {
  if ! command -v brew >/dev/null 2>&1; then
    echo "ERROR: Homebrew is required on macOS to install an ffmpeg with the WHIP muxer." >&2
    return 1
  fi
  echo "Installing a WHIP-capable ffmpeg via Homebrew (this can take a few minutes)…"
  brew upgrade ffmpeg || true
  brew install ffmpeg || true
  if find_whip_ffmpeg >/dev/null; then
    return 0
  fi
  echo "Core Homebrew ffmpeg still has no WHIP muxer — trying ffmpeg-full…"
  brew tap homebrew-ffmpeg/ffmpeg || true
  brew install ffmpeg-full || brew install homebrew-ffmpeg/ffmpeg/ffmpeg || true
  find_whip_ffmpeg >/dev/null
}

WHIP_FFMPEG="$(find_whip_ffmpeg || true)"
if [[ -z "$WHIP_FFMPEG" ]]; then
  if ! install_whip_ffmpeg; then
    echo "ERROR: could not install an ffmpeg with a WHIP muxer (\`-f whip\`). WebRTC publish will fail." >&2
    echo "  Install Homebrew, then re-run ./scripts/run-local-publisher.sh" >&2
    rm -f "$ENV_FILE"
    exit 1
  fi
  WHIP_FFMPEG="$(find_whip_ffmpeg || true)"
fi

if [[ -z "$WHIP_FFMPEG" ]]; then
  echo "ERROR: ffmpeg is present but has no WHIP muxer, and Homebrew could not provide one." >&2
  echo "  The publisher agent will not start. Re-run this script after ffmpeg can list:" >&2
  echo "    ffmpeg -hide_banner -muxers | grep whip" >&2
  rm -f "$ENV_FILE"
  exit 1
fi

write_ffmpeg_env "$WHIP_FFMPEG"
# shellcheck disable=SC1090
source "$ENV_FILE"
echo "ffmpeg: ok ($WHIP_FFMPEG, WHIP muxer present)"
echo "Publisher tools check complete."
