#!/usr/bin/env bash
# Write GCP us-east1 stack env from terraform outputs or explicit IPs.
#
# Usage:
#   ./infra/scripts/update-gcp-east-endpoints.sh
#   GCP_EAST_ZIXI_IP=… GCP_EAST_WEB_IP=… GCP_EAST_RELAY_IP=… ./infra/scripts/update-gcp-east-endpoints.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_TF="$REPO_ROOT/infra/web/terraform/gcp-us-east1"
ZIXI_TF="$REPO_ROOT/infra/zixi/terraform/gcp-us-east1"
RELAY_TF="$REPO_ROOT/infra/moqx/terraform/gcp-us-east1"

tf_ip() {
  local dir="$1"
  if [[ -d "$dir" ]] && command -v terraform >/dev/null 2>&1; then
    terraform -chdir="$dir" output -raw public_ip 2>/dev/null || true
  fi
}

ZIXI_IP="${GCP_EAST_ZIXI_IP:-${1:-$(tf_ip "$ZIXI_TF")}}"
WEB_IP="${GCP_EAST_WEB_IP:-${2:-$(tf_ip "$WEB_TF")}}"
RELAY_IP="${GCP_EAST_RELAY_IP:-${3:-$(tf_ip "$RELAY_TF")}}"
REGION="${GCP_EAST_REGION:-us-east1}"

if [[ -z "$ZIXI_IP" || -z "$WEB_IP" || -z "$RELAY_IP" ]]; then
  echo "Usage: $0 [zixi-ip web-ip relay-ip]" >&2
  echo "Or export GCP_EAST_ZIXI_IP, GCP_EAST_WEB_IP, GCP_EAST_RELAY_IP." >&2
  exit 1
fi

RELAY_DOMAIN="${GCP_EAST_RELAY_DOMAIN:-${RELAY_IP//./-}.sslip.io}"
ENV_FILE="$REPO_ROOT/infra/web/scripts/gcp-east-stack.env.example"

cat > "$ENV_FILE" <<EOF
# GCP us-east1 mirror stack — merge into the orchestrator /etc/moq-web.env
GCP_EAST_STACK_ENABLED=1
GCP_EAST_REGION=${REGION}
GCP_EAST_ZIXI_IP=${ZIXI_IP}
GCP_EAST_WEB_IP=${WEB_IP}
GCP_EAST_RELAY_IP=${RELAY_IP}
GCP_EAST_RELAY_DOMAIN=${RELAY_DOMAIN}
GCP_EAST_METRICS_ZONE=${REGION}-b
GCP_EAST_INSTANCE_ZIXI=moq-zixi-east-gcp
GCP_EAST_INSTANCE_MEDIAMTX=moq-web-east-gcp
GCP_EAST_INSTANCE_MOQX=moq-relay-east-gcp
EOF

echo "Wrote ${ENV_FILE}"
echo "  Zixi:   ${ZIXI_IP}"
echo "  Web:    ${WEB_IP}"
echo "  Relay:  ${RELAY_IP} (${RELAY_DOMAIN})"
echo ""
echo "On the us-central1 web VM, merge these into /etc/moq-web.env and restart moq-web."
