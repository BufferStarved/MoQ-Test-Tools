#!/usr/bin/env bash
# Provision the GCP MoQ relay VM with Terraform.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$ROOT_DIR/terraform/gcp"
TFVARS="$TF_DIR/terraform.tfvars"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1"; exit 1; }
}

require_cmd terraform
require_cmd gcloud

if ! gcloud auth application-default print-access-token >/dev/null 2>&1; then
  echo "ADC not configured. Run:"
  echo "  gcloud auth application-default login"
  exit 1
fi

PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "(unset)" ]]; then
  read -r -p "GCP project ID: " PROJECT_ID
  gcloud config set project "$PROJECT_ID"
fi

if [[ ! -f "$TFVARS" ]]; then
  echo "Creating $TFVARS"

  PUB_IP="$(curl -4 -s ifconfig.me 2>/dev/null || true)"
  if [[ -z "$PUB_IP" ]]; then
    PUB_IP="$(curl -s ifconfig.me 2>/dev/null || true)"
  fi

  if [[ "$PUB_IP" == *:* ]]; then
    SSH_CIDR="${PUB_IP}/128"
  else
    SSH_CIDR="${PUB_IP}/32"
  fi

  SSH_KEY="${HOME}/.ssh/id_ed25519.pub"
  if [[ ! -f "$SSH_KEY" ]]; then
    SSH_KEY="${HOME}/.ssh/id_rsa.pub"
  fi

  read -r -p "Let's Encrypt email: " CERTBOT_EMAIL

  cat >"$TFVARS" <<EOF
project_name = "moq-relay"
project_id   = "${PROJECT_ID}"
region       = "us-central1"
zone         = "us-central1-a"
machine_type = "e2-standard-4"
ssh_public_key_path = "${SSH_KEY}"
allowed_ssh_cidr = "${SSH_CIDR}"
allowed_client_cidr = "0.0.0.0/0"
moqx_port = 4433
moqx_pico_port = 4434
moqx_admin_port = 8000
certbot_email = "${CERTBOT_EMAIL}"
EOF
  echo "Wrote $TFVARS (SSH allowed from ${SSH_CIDR})"
else
  echo "Using existing $TFVARS"
fi

echo "Enabling Compute Engine API (if needed)..."
gcloud services enable compute.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true

cd "$TF_DIR"
terraform init -input=false
terraform plan -out=tfplan
echo ""
read -r -p "Apply this plan? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  terraform apply tfplan
  echo ""
  terraform output
  RELAY_IP="$(terraform output -raw public_ip)"
  echo ""
  echo "Next: install moqx with TLS"
  echo "  $ROOT_DIR/scripts/gcp-install-moqx.sh ${RELAY_IP}"
else
  echo "Aborted."
fi
