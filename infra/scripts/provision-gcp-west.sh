#!/usr/bin/env bash
# Provision GCP us-west1 (Oregon) WITHOUT touching us-central1 or us-east1 state.
# Sibling terraform dirs symlink the existing modules. The three west VMs share
# one VPC (moq-web-west-vpc) like east. Project NETWORKS quota is 5/5 today —
# apply will fail until that quota is raised or unused `default` is deleted.
#
# Usage:
#   ./infra/scripts/provision-gcp-west.sh          # plan only
#   TF_AUTO_APPROVE=1 ./infra/scripts/provision-gcp-west.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGION="${GCP_WEST_REGION:-us-west1}"
ZONE="${GCP_WEST_ZONE:-us-west1-a}"
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

WEB_DIR="$REPO_ROOT/infra/web/terraform/gcp-us-west1"
ZIXI_DIR="$REPO_ROOT/infra/zixi/terraform/gcp-us-west1"
RELAY_DIR="$REPO_ROOT/infra/moqx/terraform/gcp-us-west1"

link_module "$WEB_DIR" "$REPO_ROOT/infra/web/terraform/gcp"
link_module "$ZIXI_DIR" "$REPO_ROOT/infra/zixi/terraform/gcp"
link_module "$RELAY_DIR" "$REPO_ROOT/infra/moqx/terraform/gcp"

write_tfvars "$WEB_DIR" "moq-web-west" "$(cat <<EOF
disk_size_gb = 50
allowed_http_cidr = "0.0.0.0/0"
web_domain = "unused-orchestrator-stays-us-central1"
EOF
)"
write_tfvars "$ZIXI_DIR" "moq-zixi-west" "$(cat <<EOF
allowed_ingest_cidr = "0.0.0.0/0"
srt_listen_port = 2088
existing_network = "moq-web-west-vpc"
EOF
)"
write_tfvars "$RELAY_DIR" "moq-relay-west" "$(cat <<EOF
allowed_client_cidr = "0.0.0.0/0"
moqx_port = 4433
moqx_pico_port = 4434
moqx_admin_port = 8000
certbot_email = "${CERTBOT_EMAIL}"
existing_network = "moq-web-west-vpc"
EOF
)"

gcloud services enable compute.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true

if [[ "$AUTO" == "1" ]]; then
  used="$(gcloud compute project-info describe --format='value(quotas.filter("metric=NETWORKS").usage)' --project="$PROJECT_ID" 2>/dev/null || true)"
  limit="$(gcloud compute project-info describe --format='value(quotas.filter("metric=NETWORKS").limit)' --project="$PROJECT_ID" 2>/dev/null || true)"
  if [[ -n "$used" && -n "$limit" ]]; then
    echo "NETWORKS quota: ${used}/${limit}"
    if python3 -c "import sys; sys.exit(0 if float('${used}') >= float('${limit}') else 1)"; then
      echo "Refusing apply: NETWORKS quota is exhausted. West needs one new VPC (moq-web-west-vpc)." >&2
      echo "Raise the quota or delete unused default, then re-run." >&2
      exit 1
    fi
  fi
fi

apply_stack "$WEB_DIR"
apply_stack "$ZIXI_DIR"
apply_stack "$RELAY_DIR"

if [[ "$AUTO" == "1" ]]; then
  "$REPO_ROOT/infra/scripts/update-gcp-west-endpoints.sh"
  echo ""
  echo "Next (install software on the new VMs, IAP SSH):"
  echo "  gcloud compute ssh ubuntu@moq-web-west-gcp --zone=${ZONE} --tunnel-through-iap"
  echo "  PUBLIC_IP=\$(terraform -chdir=${WEB_DIR} output -raw public_ip) \\"
  echo "    bash infra/mediamtx/scripts/install-mediamtx.sh"
  echo "  bash infra/moqx/scripts/gcp-install-moqx.sh \$(terraform -chdir=${RELAY_DIR} output -raw public_ip) ${CERTBOT_EMAIL}"
  echo "  # Zixi: copy installer then infra/zixi/scripts/gcp-install-zixi.sh (point TF_DIR at gcp-us-west1)"
  echo "  # Do not leave an unlicensed Broadcaster running — activate license.zixi.com first."
fi
