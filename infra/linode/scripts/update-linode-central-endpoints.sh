#!/usr/bin/env bash
# Write Linode us-central (Dallas) stack env from terraform outputs or explicit IPs.
#
# Usage:
#   ./infra/linode/scripts/update-linode-central-endpoints.sh
#   LINODE_CENTRAL_ZIXI_IP=… LINODE_CENTRAL_WEB_IP=… LINODE_CENTRAL_RELAY_IP=… \
#     ./infra/linode/scripts/update-linode-central-endpoints.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WEB_TF="$REPO_ROOT/infra/web/terraform/linode-us-central"
ZIXI_TF="$REPO_ROOT/infra/zixi/terraform/linode-us-central"
RELAY_TF="$REPO_ROOT/infra/moqx/terraform/linode-us-central"

tf_ip() {
  local dir="$1"
  if [[ -d "$dir" ]] && command -v terraform >/dev/null 2>&1; then
    terraform -chdir="$dir" output -raw public_ip 2>/dev/null || true
  fi
}

ZIXI_IP="${LINODE_CENTRAL_ZIXI_IP:-${1:-$(tf_ip "$ZIXI_TF")}}"
WEB_IP="${LINODE_CENTRAL_WEB_IP:-${2:-$(tf_ip "$WEB_TF")}}"
RELAY_IP="${LINODE_CENTRAL_RELAY_IP:-${3:-$(tf_ip "$RELAY_TF")}}"
REGION="${LINODE_CENTRAL_REGION:-us-central}"

if [[ -z "$ZIXI_IP" || -z "$WEB_IP" || -z "$RELAY_IP" ]]; then
  echo "Usage: $0 [zixi-ip web-ip relay-ip]" >&2
  echo "Or export LINODE_CENTRAL_ZIXI_IP, LINODE_CENTRAL_WEB_IP, LINODE_CENTRAL_RELAY_IP." >&2
  exit 1
fi

RELAY_DOMAIN="${LINODE_CENTRAL_RELAY_DOMAIN:-${RELAY_IP//./-}.sslip.io}"
ENV_FILE="$REPO_ROOT/infra/web/scripts/linode-central-stack.env.example"

cat > "$ENV_FILE" <<EOF
# Linode us-central (Dallas) mirror stack — merge into the orchestrator /etc/moq-web.env
LINODE_CENTRAL_STACK_ENABLED=1
LINODE_CENTRAL_REGION=${REGION}
LINODE_CENTRAL_ZIXI_IP=${ZIXI_IP}
LINODE_CENTRAL_WEB_IP=${WEB_IP}
LINODE_CENTRAL_RELAY_IP=${RELAY_IP}
LINODE_CENTRAL_RELAY_DOMAIN=${RELAY_DOMAIN}
EOF

echo "Wrote ${ENV_FILE}"
echo "  Zixi:   ${ZIXI_IP}"
echo "  Web:    ${WEB_IP} (MediaMTX + ingest-agent :8090)"
echo "  Relay:  ${RELAY_IP} (${RELAY_DOMAIN})"
echo ""
echo "On the GCP web VM, merge these into /etc/moq-web.env and restart moq-web."
