#!/usr/bin/env bash
# Build openmoq-recorder Docker image and install the host wrapper (dev / local).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECORDER_DIR="$ROOT/tools/openmoq-recorder"
BIN="$RECORDER_DIR/bin/openmoq-fmp4-record"
IMAGE="${MOQ_RECORDER_IMAGE:-openmoq-recorder:latest}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. On GCP ingest workers use:" >&2
  echo "  sudo bash infra/zixi/scripts/install-openmoq-recorder.sh" >&2
  exit 1
fi

cp "$RECORDER_DIR/.dockerignore" "$ROOT/.dockerignore"
docker build -f "$RECORDER_DIR/Dockerfile" -t "$IMAGE" "$ROOT"
rm -f "$ROOT/.dockerignore"

install -d "$RECORDER_DIR/bin"
install -m 0755 "$RECORDER_DIR/bin/openmoq-fmp4-record-docker" "$BIN"

if ! MOQ_RELAY_CERT_SHA256="${MOQ_RELAY_CERT_SHA256:-7115b12274dcf092c3e77d763111f0a2088a0f2029efc8e1f223a9584b1f5b54}" \
  "$BIN" --probe; then
  echo "openmoq-recorder docker probe failed" >&2
  exit 1
fi

echo "Installed docker-backed openmoq-fmp4-record to $BIN"
"$BIN" 2>&1 | head -1 || true
