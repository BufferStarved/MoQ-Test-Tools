#!/usr/bin/env bash
# Ensure Zixi HLS/DASH origin output and HTTP TS push ingest are configured.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"

if [[ -z "${ZIXI_PASSWORD:-}" ]]; then
  echo "Set ZIXI_PASSWORD before running this script." >&2
  exit 1
fi

ZIXI_HOST="$ZIXI_HOST" ZIXI_PASSWORD="$ZIXI_PASSWORD" \
  "$SCRIPT_DIR/configure-zixi-hls-dash-output.sh"
