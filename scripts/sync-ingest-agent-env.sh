#!/usr/bin/env bash
# Copy the ingest agent token from a managed VM into local .env for dev.
# Preserves MOQ publisher / other local overrides when rewriting the file.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${1:-ubuntu@35.222.33.58}"
SSH_KEY="${INGEST_SSH_KEY:-$HOME/.ssh/id_ed25519}"
ENV_FILE="$ROOT_DIR/.env"

TOKEN=$(ssh -i "$SSH_KEY" "$HOST" 'sudo grep INGEST_AGENT_TOKEN /etc/moq-ingest-agent.env | cut -d= -f2')

# Preserve known local overrides
preserve_keys=(
  MOQ_PUBLISHER_BACKEND
  OPENMOQ_PUBLISHER_BIN
  MOQ_RELAY_CERT_SHA256
  SRT_USE_LIVE_TRANSMIT
  ZIXI_API_BASE
  ZIXI_API_USER
  ZIXI_API_PASSWORD
  ZIXI_PASSWORD
)
preserved=()
if [[ -f "$ENV_FILE" ]]; then
  for key in "${preserve_keys[@]}"; do
    if line=$(grep -E "^${key}=" "$ENV_FILE" || true); then
      preserved+=("$line")
    fi
  done
fi

{
  echo "INGEST_AGENT_TOKEN=${TOKEN}"
  echo "INGEST_RECORDING_DIR=/opt/zixi_broadcaster-linux64"
  echo "INGEST_AGENT_PORT=8090"
  echo "MOQ_PUBLISHER_BACKEND=openmoq"
  echo "OPENMOQ_PUBLISHER_BIN=${ROOT_DIR}/tools/openmoq-publisher/bin/openmoq-publisher"
  echo "SRT_USE_LIVE_TRANSMIT=0"
  echo "# MoQ stack: run ./scripts/install-playa.sh (Playa 0.5.x) and ./scripts/install-openmoq-publisher.sh (v0.3.4+)"
  for line in "${preserved[@]+"${preserved[@]}"}"; do
    key="${line%%=*}"
    # Skip keys we already wrote with go-live defaults
    case "$key" in
      MOQ_PUBLISHER_BACKEND|OPENMOQ_PUBLISHER_BIN) continue ;;
    esac
    echo "$line"
  done
} > "$ENV_FILE"

chmod 600 "$ENV_FILE"
echo "Wrote $ENV_FILE"
