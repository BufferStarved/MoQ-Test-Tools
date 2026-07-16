#!/usr/bin/env bash
# Install ffmpeg with libvmaf support on a Zixi ingest VM (Ubuntu 22.04).
#
# Ubuntu's distro ffmpeg is often built without libvmaf even when libvmaf2 is
# installed. When apt cannot provide libvmaf, this script installs a static
# BtbN GPL build to /usr/local/bin/ffmpeg (same path expected by the ingest agent).
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo on the ingest VM."
  exit 1
fi

FFMPEG_TARGET="/usr/local/bin/ffmpeg"
AGENT_ENV="/etc/moq-ingest-agent.env"
BTBN_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"

has_libvmaf() {
  local bin="$1"
  [[ -x "$bin" ]] && "$bin" -hide_banner -filters 2>/dev/null | grep -qw libvmaf
}

configure_agent_ffmpeg() {
  if [[ ! -f "$AGENT_ENV" ]]; then
    return 0
  fi
  if grep -q "^INGEST_FFMPEG_BIN=" "$AGENT_ENV"; then
    sed -i "s|^INGEST_FFMPEG_BIN=.*|INGEST_FFMPEG_BIN=${FFMPEG_TARGET}|" "$AGENT_ENV"
  else
    echo "INGEST_FFMPEG_BIN=${FFMPEG_TARGET}" >> "$AGENT_ENV"
  fi
  if systemctl is-enabled moq-ingest-agent.service >/dev/null 2>&1; then
    systemctl restart moq-ingest-agent.service
  fi
}

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates python3 libvmaf2 || true
apt-get install -y ffmpeg || true

for candidate in "$FFMPEG_TARGET" /usr/bin/ffmpeg ffmpeg; do
  if has_libvmaf "$candidate"; then
    echo "ffmpeg libvmaf is available at ${candidate}."
    "$candidate" -version | head -1
    if [[ "$candidate" != "$FFMPEG_TARGET" ]]; then
      install -m 755 "$candidate" "$FFMPEG_TARGET"
    fi
    configure_agent_ffmpeg
    exit 0
  fi
done

echo "Distro ffmpeg lacks libvmaf; installing static BtbN build to ${FFMPEG_TARGET}..."
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

curl -fsSL -o ffmpeg.tar.xz "$BTBN_URL"
tar -xf ffmpeg.tar.xz
SRC="$(find . -type f -path '*/bin/ffmpeg' | head -1)"
if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "ERROR: could not find ffmpeg binary in downloaded archive." >&2
  exit 1
fi

install -m 755 "$SRC" "$FFMPEG_TARGET"

if ! has_libvmaf "$FFMPEG_TARGET"; then
  echo "ERROR: installed ffmpeg at ${FFMPEG_TARGET} still lacks libvmaf." >&2
  exit 1
fi

echo "ffmpeg libvmaf is available at ${FFMPEG_TARGET}."
"$FFMPEG_TARGET" -version | head -1
configure_agent_ffmpeg

if systemctl is-active moq-ingest-agent.service >/dev/null 2>&1; then
  curl -fsS "http://127.0.0.1:8090/api/v1/health" || true
  echo ""
fi
