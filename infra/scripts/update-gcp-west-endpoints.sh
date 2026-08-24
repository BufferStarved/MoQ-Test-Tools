#!/usr/bin/env bash
# Write GCP us-west1 stack env from terraform outputs or explicit IPs.
#
# Usage:
#   ./infra/scripts/update-gcp-west-endpoints.sh
#   GCP_WEST_ZIXI_IP=… GCP_WEST_WEB_IP=… GCP_WEST_RELAY_IP=… ./infra/scripts/update-gcp-west-endpoints.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_TF="$REPO_ROOT/infra/web/terraform/gcp-us-west1"
ZIXI_TF="$REPO_ROOT/infra/zixi/terraform/gcp-us-west1"
RELAY_TF="$REPO_ROOT/infra/moqx/terraform/gcp-us-west1"

tf_ip() {
  local dir="$1"
  if [[ -d "$dir" ]] && command -v terraform >/dev/null 2>&1; then
    terraform -chdir="$dir" output -raw public_ip 2>/dev/null || true
  fi
}

ZIXI_IP="${GCP_WEST_ZIXI_IP:-${1:-$(tf_ip "$ZIXI_TF")}}"
WEB_IP="${GCP_WEST_WEB_IP:-${2:-$(tf_ip "$WEB_TF")}}"
RELAY_IP="${GCP_WEST_RELAY_IP:-${3:-$(tf_ip "$RELAY_TF")}}"
REGION="${GCP_WEST_REGION:-us-west1}"

if [[ -z "$ZIXI_IP" || -z "$WEB_IP" || -z "$RELAY_IP" ]]; then
  echo "Usage: $0 [zixi-ip web-ip relay-ip]" >&2
  echo "Or export GCP_WEST_ZIXI_IP, GCP_WEST_WEB_IP, GCP_WEST_RELAY_IP." >&2
  exit 1
fi

RELAY_DOMAIN="${GCP_WEST_RELAY_DOMAIN:-${RELAY_IP//./-}.sslip.io}"
ENV_FILE="$REPO_ROOT/infra/web/scripts/gcp-west-stack.env.example"

cat > "$ENV_FILE" <<EOF
# GCP us-west1 (Oregon) mirror stack — merge into the orchestrator /etc/moq-web.env
GCP_WEST_STACK_ENABLED=1
GCP_WEST_REGION=${REGION}
GCP_WEST_ZIXI_IP=${ZIXI_IP}
GCP_WEST_WEB_IP=${WEB_IP}
GCP_WEST_RELAY_IP=${RELAY_IP}
GCP_WEST_RELAY_DOMAIN=${RELAY_DOMAIN}
GCP_WEST_METRICS_ZONE=${REGION}-a
GCP_WEST_INSTANCE_ZIXI=moq-zixi-west-gcp
GCP_WEST_INSTANCE_MEDIAMTX=moq-web-west-gcp
GCP_WEST_INSTANCE_MOQX=moq-relay-west-gcp
EOF

echo "Wrote ${ENV_FILE}"
echo "  Zixi:   ${ZIXI_IP}"
echo "  Web:    ${WEB_IP}"
echo "  Relay:  ${RELAY_IP} (${RELAY_DOMAIN})"
echo ""
echo "On the us-central1 web VM, merge these into /etc/moq-web.env and restart moq-web."
