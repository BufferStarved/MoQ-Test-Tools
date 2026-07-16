#!/usr/bin/env bash
# Guided deployment wrapper — runs terraform in each cloud directory.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLOUD="${1:-}"

usage() {
  cat <<EOF
Usage: $0 <aws|gcp|linode|all>

Deploys Zixi-ready VMs using Terraform.

Before running:
  1. ./scripts/install-prerequisites.sh
  2. Configure cloud credentials (see README.md)
  3. cp terraform/<cloud>/terraform.tfvars.example terraform/<cloud>/terraform.tfvars
     and edit allowed_ssh_cidr (+ project_id for GCP)

Examples:
  $0 aws
  $0 gcp
  $0 linode
  $0 all
EOF
}

deploy_cloud() {
  local cloud="$1"
  local dir="$ROOT_DIR/terraform/$cloud"

  if [[ ! -f "$dir/terraform.tfvars" ]]; then
    echo "Missing $dir/terraform.tfvars"
    echo "Run: cp $dir/terraform.tfvars.example $dir/terraform.tfvars"
    exit 1
  fi

  echo "=== Deploying $cloud ==="
  cd "$dir"
  terraform init -input=false
  terraform plan -out=tfplan
  terraform apply tfplan
  echo ""
  terraform output
  echo ""
}

case "$CLOUD" in
  aws|gcp|linode)
    deploy_cloud "$CLOUD"
    ;;
  all)
    for c in aws gcp linode; do
      deploy_cloud "$c"
    done
    ;;
  *)
    usage
    exit 1
    ;;
esac

echo "Next: install Zixi Broadcaster on each VM (see README.md)"
