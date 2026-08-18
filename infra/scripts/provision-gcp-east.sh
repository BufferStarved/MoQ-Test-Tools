#!/usr/bin/env bash
# Provision a second GCP region (us-east1) WITHOUT touching us-central1 state.
# Uses sibling terraform dirs that symlink the existing modules.
#
# Usage:
#   ./infra/scripts/provision-gcp-east.sh          # plan only
#   TF_AUTO_APPROVE=1 ./infra/scripts/provision-gcp-east.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGION="${GCP_EAST_REGION:-us-east1}"
ZONE="${GCP_EAST_ZONE:-us-east1-b}"
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
SSH_KEY="${HOME}/.ssh/id_ed25519.pub"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="${HOME}/.ssh/id_rsa.pub"
fi
SSH_CIDR="${ALLOWED_SSH_CIDR:-185.104.139.120/32}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@sean-mccarthy.net}"
AUTO="${TF_AUTO_APPROVE:-0}"

if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  echo "Set GCP_PROJECT_ID or gcloud config set project" >&2
  exit 1
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing $1" >&2; exit 1; }
}
require_cmd terraform
require_cmd gcloud

link_module() {
  local dest="$1"
  local src="$2"
  mkdir -p "$dest"
  for f in main.tf variables.tf outputs.tf; do
    if [[ ! -e "$dest/$f" ]]; then
      ln -s "../$(basename "$src")/$f" "$dest/$f"
    fi
  done
}

write_tfvars() {
  local dest="$1"
  local name="$2"
  local extra="$3"
  local tfvars="$dest/terraform.tfvars"
  if [[ -f "$tfvars" ]]; then
    echo "Using existing $tfvars"
    return
  fi
  cat >"$tfvars" <<EOF
project_name = "${name}"
project_id   = "${PROJECT_ID}"
region       = "${REGION}"
zone         = "${ZONE}"
machine_type = "e2-standard-4"
ssh_public_key_path = "${SSH_KEY}"
allowed_ssh_cidr = "${SSH_CIDR}"
${extra}
EOF
  echo "Wrote $tfvars"
}

apply_stack() {
  local dest="$1"
  echo ""
  echo "=== terraform ${AUTO/1/apply}${AUTO/0/plan}: $dest ==="
  terraform -chdir="$dest" init -input=false
  if [[ "$AUTO" == "1" ]]; then
    terraform -chdir="$dest" apply -input=false -auto-approve
  else
    terraform -chdir="$dest" plan
  fi
}

WEB_DIR="$REPO_ROOT/infra/web/terraform/gcp-us-east1"
ZIXI_DIR="$REPO_ROOT/infra/zixi/terraform/gcp-us-east1"
RELAY_DIR="$REPO_ROOT/infra/moqx/terraform/gcp-us-east1"

link_module "$WEB_DIR" "$REPO_ROOT/infra/web/terraform/gcp"
link_module "$ZIXI_DIR" "$REPO_ROOT/infra/zixi/terraform/gcp"
link_module "$RELAY_DIR" "$REPO_ROOT/infra/moqx/terraform/gcp"

write_tfvars "$WEB_DIR" "moq-web-east" "$(cat <<EOF
disk_size_gb = 50
allowed_http_cidr = "0.0.0.0/0"
web_domain = "unused-orchestrator-stays-us-central1"
EOF
)"
write_tfvars "$ZIXI_DIR" "moq-zixi-east" "$(cat <<EOF
allowed_ingest_cidr = "0.0.0.0/0"
srt_listen_port = 2088
existing_network = "moq-web-east-vpc"
EOF
)"
write_tfvars "$RELAY_DIR" "moq-relay-east" "$(cat <<EOF
allowed_client_cidr = "0.0.0.0/0"
moqx_port = 4433
moqx_pico_port = 4434
moqx_admin_port = 8000
certbot_email = "${CERTBOT_EMAIL}"
existing_network = "moq-web-east-vpc"
EOF
)"

gcloud services enable compute.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true

apply_stack "$WEB_DIR"
apply_stack "$ZIXI_DIR"
apply_stack "$RELAY_DIR"

if [[ "$AUTO" == "1" ]]; then
  "$REPO_ROOT/infra/scripts/update-gcp-east-endpoints.sh"
  echo ""
  echo "Next (install software on the new VMs, IAP SSH):"
  echo "  gcloud compute ssh ubuntu@moq-web-east-gcp --zone=${ZONE} --tunnel-through-iap"
  echo "  PUBLIC_IP=\$(terraform -chdir=${WEB_DIR} output -raw public_ip) \\"
  echo "    bash infra/mediamtx/scripts/install-mediamtx.sh"
  echo "  bash infra/moqx/scripts/gcp-install-moqx.sh \$(terraform -chdir=${RELAY_DIR} output -raw public_ip) ${CERTBOT_EMAIL}"
  echo "  # Zixi: copy installer then infra/zixi/scripts/gcp-install-zixi.sh (point TF_DIR at gcp-us-east1)"
fi
