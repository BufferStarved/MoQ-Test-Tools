#!/usr/bin/env bash
# Build moq5-fmp4-record on the GCP ingest worker (subscribes to MoQ relays remotely).
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo"
  exit 1
fi

RECORDER_ROOT="${1:-/opt/moq5-recorder}"
MOQ_RECORDING_DIR="${2:-/var/lib/moq-relay-recordings}"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
AGENT_ENV="/etc/moq-ingest-agent.env"

apt-get update
apt-get install -y cmake pkg-config git curl build-essential libssl-dev

if [[ ! -x "$REPO_DIR/scripts/install-moq5-recorder.sh" ]]; then
  echo "Missing $REPO_DIR/scripts/install-moq5-recorder.sh"
  exit 1
fi

export PATH="/usr/local/bin:${PATH:-}"
rm -f "$REPO_DIR/tools/moq5-recorder/bin/moq5-fmp4-record" \
  "$REPO_DIR/tools/moq5-publisher/bin/moq5-fmp4-publish"
bash "$REPO_DIR/scripts/install-moq5-recorder.sh"

install -d "$RECORDER_ROOT/bin" "$MOQ_RECORDING_DIR"
install -m 0755 "$REPO_DIR/tools/moq5-recorder/bin/moq5-fmp4-record" \
  "$RECORDER_ROOT/bin/moq5-fmp4-record"

if [[ -f "$AGENT_ENV" ]]; then
  for key in MOQ_RECORDER_BIN MOQ_RELAY_URL; do
    grep -q "^${key}=" "$AGENT_ENV" && continue
    case "$key" in
      MOQ_RECORDER_BIN) echo "MOQ_RECORDER_BIN=${RECORDER_ROOT}/bin/moq5-fmp4-record" >> "$AGENT_ENV" ;;
      MOQ_RELAY_URL) echo "MOQ_RELAY_URL=https://34-28-164-90.sslip.io:4433/moq-relay" >> "$AGENT_ENV" ;;
    esac
  done
  if grep -q "^MOQ_RECORDER_BIN=" "$AGENT_ENV"; then
    sed -i "s|^MOQ_RECORDER_BIN=.*|MOQ_RECORDER_BIN=${RECORDER_ROOT}/bin/moq5-fmp4-record|" "$AGENT_ENV"
  fi
  systemctl restart moq-ingest-agent.service 2>/dev/null || true
fi

echo "Installed moq5-fmp4-record to ${RECORDER_ROOT}/bin/moq5-fmp4-record"
echo "MoQ relay recordings: ${MOQ_RECORDING_DIR}"
"${RECORDER_ROOT}/bin/moq5-fmp4-record" 2>&1 | head -1 || true
