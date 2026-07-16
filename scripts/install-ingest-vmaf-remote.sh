#!/usr/bin/env bash
# Install ffmpeg+libvmaf on a managed Zixi ingest VM over SSH.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${1:-ubuntu@35.222.33.58}"
SSH_KEY="${INGEST_SSH_KEY:-$HOME/.ssh/id_ed25519}"

echo "Installing ingest VMAF ffmpeg on ${HOST}..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$HOST" \
  "sudo bash -s" < "$ROOT_DIR/infra/zixi/scripts/install-ingest-vmaf.sh"

echo ""
echo "Remote health:"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$HOST" \
  "curl -fsS http://127.0.0.1:8090/api/v1/health"
