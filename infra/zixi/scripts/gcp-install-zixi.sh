#!/usr/bin/env bash
# Upload Zixi installer to GCP VM and run remote install.
set -euo pipefail

INSTALLER="${1:-}"
if [[ -z "$INSTALLER" || ! -f "$INSTALLER" ]]; then
  cat <<EOF
Usage: $0 <path-to-zixi-linux-installer.tar.gz|.tar.xz>

Download the Linux installer from https://portal.zixi.com first:
  Software → Zixi Broadcaster → Linux

Example:
  $0 ~/Downloads/ZixiBroadcaster-linux.tar.gz
EOF
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$ROOT_DIR/terraform/gcp"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1"; exit 1; }
}

require_cmd gcloud
require_cmd scp
require_cmd ssh

cd "$TF_DIR"
if ! terraform output -raw public_ip >/dev/null 2>&1; then
  echo "No Terraform outputs found. Deploy the VM first:"
  echo "  ./scripts/gcp-deploy-vm.sh"
  exit 1
fi

PUBLIC_IP="$(terraform output -raw public_ip)"
REMOTE_INSTALLER="/tmp/$(basename "$INSTALLER")"
SSH_USER="ubuntu"
SSH_KEY="${HOME}/.ssh/id_ed25519"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="${HOME}/.ssh/id_rsa"
fi

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

echo "Uploading installer to ${SSH_USER}@${PUBLIC_IP}..."
scp "${SSH_OPTS[@]}" "$INSTALLER" "${SSH_USER}@${PUBLIC_IP}:${REMOTE_INSTALLER}"
scp "${SSH_OPTS[@]}" "$ROOT_DIR/scripts/zixi-remote-install.sh" "${SSH_USER}@${PUBLIC_IP}:/tmp/zixi-remote-install.sh"

echo "Running remote install (may prompt for confirmations)..."
ssh -t "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "sudo bash /tmp/zixi-remote-install.sh ${REMOTE_INSTALLER}"

echo ""
echo "Verify from your machine:"
"$ROOT_DIR/scripts/verify-zixi-host.sh" "$PUBLIC_IP"
echo ""
echo "Zixi web UI: http://${PUBLIC_IP}:4444"
echo "SRT endpoint: srt://${PUBLIC_IP}:2088?mode=caller&latency=200000"
