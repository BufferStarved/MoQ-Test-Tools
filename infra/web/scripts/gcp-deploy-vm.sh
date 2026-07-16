#!/usr/bin/env bash
# Provision the GCP MoQ web app VM with Terraform.
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

  cat >"$TFVARS" <<EOF
project_name = "moq-web"
project_id   = "${PROJECT_ID}"
region       = "us-central1"
zone         = "us-central1-a"
machine_type = "e2-standard-4"
disk_size_gb = 50
ssh_public_key_path = "${SSH_KEY}"
allowed_ssh_cidr  = "${SSH_CIDR}"
allowed_http_cidr = "0.0.0.0/0"
web_domain = "moq.sean-mccarthy.net"
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
  WEB_IP="$(terraform output -raw public_ip)"
  WEB_DOMAIN="$(terraform output -raw web_domain)"
  echo ""
  echo "============================================================"
  echo "DNS (required before HTTPS works):"
  echo "  A  ${WEB_DOMAIN}  ->  ${WEB_IP}"
  echo ""
  echo "Next: install the app (after DNS, or before if you will wait for cert):"
  echo "  $ROOT_DIR/scripts/install-web-app.sh ${WEB_IP}"
  echo "============================================================"
else
  echo "Aborted."
fi
