#!/usr/bin/env bash
# Patch Linode preset URLs in destinations.py from terraform outputs or explicit IPs.
#
# Usage:
#   ./infra/linode/scripts/update-linode-endpoints.sh
#   LINODE_ZIXI_IP=… LINODE_WEB_IP=… LINODE_RELAY_IP=… ./infra/linode/scripts/update-linode-endpoints.sh
#   ./infra/linode/scripts/update-linode-endpoints.sh <zixi-ip> <web-ip> <relay-ip>
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ZIXI_TF="$REPO_ROOT/infra/zixi/terraform/linode"

read_ip() {
  local var_name="$1"
  local positional="${2:-}"
  if [[ -n "$positional" ]]; then
    printf '%s' "$positional"
    return
  fi
  local from_env="${!var_name:-}"
  if [[ -n "$from_env" ]]; then
    printf '%s' "$from_env"
    return
  fi
  if [[ -d "$ZIXI_TF" ]] && command -v terraform >/dev/null 2>&1; then
    case "$var_name" in
      LINODE_ZIXI_IP)
        terraform -chdir="$ZIXI_TF" output -raw public_ip 2>/dev/null || true
        ;;
    esac
  fi
}

ZIXI_IP="$(read_ip LINODE_ZIXI_IP "${1:-}")"
WEB_IP="$(read_ip LINODE_WEB_IP "${2:-}")"
RELAY_IP="$(read_ip LINODE_RELAY_IP "${3:-}")"
REGION="${LINODE_REGION:-us-east}"

if [[ -z "$ZIXI_IP" || -z "$WEB_IP" || -z "$RELAY_IP" ]]; then
  echo "Usage: $0 [zixi-ip web-ip relay-ip]" >&2
  echo "Or export LINODE_ZIXI_IP, LINODE_WEB_IP, LINODE_RELAY_IP (and optional LINODE_REGION)." >&2
  exit 1
fi

RELAY_DOMAIN="${LINODE_RELAY_DOMAIN:-${RELAY_IP//./-}.sslip.io}"
ENV_FILE="$REPO_ROOT/infra/web/scripts/linode-stack.env.example"

cat > "$ENV_FILE" <<EOF
# Linode mirror stack — source for web VM /etc/moq-web.env and local dev.
LINODE_STACK_ENABLED=1
LINODE_REGION=${REGION}
LINODE_ZIXI_IP=${ZIXI_IP}
LINODE_WEB_IP=${WEB_IP}
LINODE_RELAY_IP=${RELAY_IP}
LINODE_RELAY_DOMAIN=${RELAY_DOMAIN}
EOF

echo "Wrote ${ENV_FILE}"
echo "  Zixi:   ${ZIXI_IP}"
echo "  Web:    ${WEB_IP} (MediaMTX + ingest-agent :8090)"
echo "  Relay:  ${RELAY_IP} (${RELAY_DOMAIN})"
echo ""
echo "On the GCP web VM, merge these into /etc/moq-web.env and restart moq-web."
echo "Locally: export \$(grep -v '^#' ${ENV_FILE} | xargs) before ./scripts/dev.sh"
