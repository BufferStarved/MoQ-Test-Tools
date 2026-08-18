#!/usr/bin/env bash
# Install openmoq-recorder on GCP ingest worker via Docker (glibc 2.39 on noble).
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo"
  exit 1
fi

MOQ_RECORDING_DIR="${2:-/var/lib/moq-relay-recordings}"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
AGENT_ENV="/etc/moq-ingest-agent.env"
MOQ_RELAY_URL="${MOQ_RELAY_URL:-https://34-28-164-90.sslip.io:4433/moq-relay}"
RECORDER_DIR="$REPO_DIR/tools/openmoq-recorder"
IMAGE="openmoq-recorder:latest"
RECORDER_BIN="$RECORDER_DIR/bin/openmoq-fmp4-record"

apt-get update
apt-get install -y curl ca-certificates openssl
# docker-ce (containerd.io) is already on the GCP/Linode web VMs — do not
# apt-get install docker.io or the resolver conflicts and the recorder never
# gets built.
if ! command -v docker >/dev/null 2>&1; then
  apt-get install -y docker.io
  systemctl enable --now docker 2>/dev/null || true
fi

cp "$RECORDER_DIR/.dockerignore" "$REPO_DIR/.dockerignore"
docker build -f "$RECORDER_DIR/Dockerfile" -t "$IMAGE" "$REPO_DIR"
rm -f "$REPO_DIR/.dockerignore"

install -d "$RECORDER_DIR/bin" "$MOQ_RECORDING_DIR"
install -m 0755 "$RECORDER_DIR/bin/openmoq-fmp4-record-docker" "$RECORDER_BIN"

# Ensure docker runs with host networking (QUIC UDP); older installs may lack this.
grep -Fq -- '--network host' "$RECORDER_BIN" || {
  echo "openmoq-fmp4-record wrapper missing --network host; reinstall from repo" >&2
  exit 1
}

if ! "$RECORDER_BIN" --probe; then
  echo "openmoq-recorder docker probe failed" >&2
  exit 1
fi

# Per-relay pins live in tools/openmoq-recorder/cert.mjs. A single
# MOQ_RELAY_CERT_SHA256 in the agent env overrides hostname lookup and
# breaks east/Linode ingest VMAF (Opening handshake failed).
if [[ -f "$AGENT_ENV" ]]; then
  sed -i '/^MOQ_RELAY_CERT_SHA256=/d' "$AGENT_ENV" || true
  for key in MOQ_RECORDER_BIN MOQ_RELAY_URL MOQ_RECORDER_IMAGE; do
    grep -q "^${key}=" "$AGENT_ENV" && continue
    case "$key" in
      MOQ_RECORDER_BIN) echo "MOQ_RECORDER_BIN=${RECORDER_BIN}" >> "$AGENT_ENV" ;;
      MOQ_RELAY_URL) echo "MOQ_RELAY_URL=${MOQ_RELAY_URL}" >> "$AGENT_ENV" ;;
      MOQ_RECORDER_IMAGE) echo "MOQ_RECORDER_IMAGE=${IMAGE}" >> "$AGENT_ENV" ;;
    esac
  done
  sed -i "s|^MOQ_RECORDER_BIN=.*|MOQ_RECORDER_BIN=${RECORDER_BIN}|" "$AGENT_ENV"
  grep -q "^MOQ_RELAY_URL=" "$AGENT_ENV" || echo "MOQ_RELAY_URL=${MOQ_RELAY_URL}" >> "$AGENT_ENV"
  sed -i "s|^MOQ_RECORDER_IMAGE=.*|MOQ_RECORDER_IMAGE=${IMAGE}|" "$AGENT_ENV" 2>/dev/null || \
    echo "MOQ_RECORDER_IMAGE=${IMAGE}" >> "$AGENT_ENV"
  systemctl restart moq-ingest-agent.service 2>/dev/null || true
fi

echo "Installed docker-backed openmoq-fmp4-record to ${RECORDER_BIN}"
echo "MoQ relay recordings: ${MOQ_RECORDING_DIR}"
"$RECORDER_BIN" 2>&1 | head -1 || true
