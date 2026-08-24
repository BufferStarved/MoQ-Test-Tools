#!/usr/bin/env bash
# Provision a Linode region sibling WITHOUT touching the live us-east instances.
# Sibling terraform dirs symlink infra/*/terraform/linode.
#
# Usage:
#   ./infra/scripts/provision-linode-region.sh us-central          # plan only
#   ./infra/scripts/provision-linode-region.sh us-west
#   TF_AUTO_APPROVE=1 ./infra/scripts/provision-linode-region.sh us-central
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGION="${1:-}"
AUTO="${TF_AUTO_APPROVE:-0}"
SSH_KEY="${HOME}/.ssh/id_ed25519.pub"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="${HOME}/.ssh/id_rsa.pub"
fi
SSH_CIDR="${ALLOWED_SSH_CIDR:-185.104.139.120/32}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@sean-mccarthy.net}"

case "$REGION" in
  us-central|central)
    REGION="us-central"
    SLUG="central"
    ENV_PREFIX="LINODE_CENTRAL"
    ;;
  us-west|west)
    REGION="us-west"
    SLUG="west"
    ENV_PREFIX="LINODE_WEST"
    ;;
  *)
    echo "Usage: $0 us-central|us-west" >&2
    exit 1
    ;;
esac

if [[ -z "${LINODE_TOKEN:-}" ]]; then
  echo "LINODE_TOKEN is not set. Scaffold dirs/tfvars only; refusing terraform apply." >&2
  if [[ "$AUTO" == "1" ]]; then
    exit 1
  fi
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing $1" >&2; exit 1; }
}
require_cmd terraform

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
region       = "${REGION}"
ssh_public_key_path = "${SSH_KEY}"
allowed_ssh_cidr = "${SSH_CIDR}"
extra_ssh_ipv4_cidrs = ["173.56.66.93/32"]
register_ssh_key = false
${extra}
EOF
  echo "Wrote $tfvars"
}

apply_stack() {
  local dest="$1"
  echo ""
  echo "=== terraform ${AUTO/1/apply}${AUTO/0/plan}: $dest ==="
  if [[ -z "${LINODE_TOKEN:-}" ]]; then
    echo "skip (no LINODE_TOKEN)"
    return
  fi
  terraform -chdir="$dest" init -input=false
  if [[ "$AUTO" == "1" ]]; then
    terraform -chdir="$dest" apply -input=false -auto-approve
  else
    terraform -chdir="$dest" plan
  fi
}

WEB_DIR="$REPO_ROOT/infra/web/terraform/linode-${REGION}"
ZIXI_DIR="$REPO_ROOT/infra/zixi/terraform/linode-${REGION}"
RELAY_DIR="$REPO_ROOT/infra/moqx/terraform/linode-${REGION}"

link_module "$WEB_DIR" "$REPO_ROOT/infra/web/terraform/linode"
link_module "$ZIXI_DIR" "$REPO_ROOT/infra/zixi/terraform/linode"
link_module "$RELAY_DIR" "$REPO_ROOT/infra/moqx/terraform/linode"

write_tfvars "$WEB_DIR" "moq-web-${SLUG}" "$(cat <<EOF
instance_type = "g6-standard-4"
allowed_ingest_cidr = "0.0.0.0/0"
allowed_http_cidr = "0.0.0.0/0"
EOF
)"
write_tfvars "$ZIXI_DIR" "moq-zixi-${SLUG}" "$(cat <<EOF
instance_type = "g6-standard-4"
allowed_ingest_cidr = "0.0.0.0/0"
srt_listen_port = 10080
EOF
)"
write_tfvars "$RELAY_DIR" "moq-relay-${SLUG}" "$(cat <<EOF
instance_type = "g6-standard-4"
allowed_client_cidr = "0.0.0.0/0"
moqx_port = 4433
moqx_pico_port = 4434
moqx_admin_port = 8000
certbot_email = "${CERTBOT_EMAIL}"
EOF
)"

apply_stack "$WEB_DIR"
apply_stack "$ZIXI_DIR"
apply_stack "$RELAY_DIR"

if [[ "$AUTO" == "1" && -n "${LINODE_TOKEN:-}" ]]; then
  UPDATE="$REPO_ROOT/infra/linode/scripts/update-linode-${SLUG}-endpoints.sh"
  "$UPDATE"
  echo ""
  echo "Next: install MediaMTX / Zixi / moqx on the new ${REGION} IPs."
  echo "Do not leave an unlicensed Zixi Broadcaster running."
  echo "Wire ${ENV_PREFIX}_* into /etc/moq-web.env and restart moq-web only after merge."
fi
