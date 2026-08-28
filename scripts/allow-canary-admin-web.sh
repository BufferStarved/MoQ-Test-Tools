#!/usr/bin/env bash
# Open draft-18 canary admin TCP 18000 to the web VM only.
# Does not terraform, does not expose Prometheus to the internet.
set -euo pipefail

WEB_IP="${MOQX_ADMIN_SCRAPE_IP:-34.9.217.178}"
CANARY_ADMIN_PORT="${MOQX_CANARY_ADMIN_PORT:-18000}"

allow_gcp_instance() {
  local instance="$1"
  local rule="$2"
  local zone
  zone="$(gcloud compute instances list --filter="name=${instance}" --format='value(zone)' | awk -F/ '{print $NF}')"
  if [[ -z "$zone" ]]; then
    echo "skip ${instance}: not found"
    return 0
  fi
  if gcloud compute firewall-rules describe "$rule" --format='value(name)' >/dev/null 2>&1; then
    echo "already present: $rule"
    return 0
  fi
  local network
  network="$(
    gcloud compute instances describe "$instance" --zone="$zone" \
      --format='value(networkInterfaces[0].network)' | awk -F/ '{print $NF}'
  )"
  echo "creating $rule on $network (tcp:${CANARY_ADMIN_PORT} from ${WEB_IP}/32)"
  gcloud compute firewall-rules create "$rule" \
    --network="$network" \
    --allow="tcp:${CANARY_ADMIN_PORT}" \
    --source-ranges="${WEB_IP}/32" \
    --target-tags=moq-relay \
    --description="Web VM scrape of draft-18 canary admin (not public)"
}

allow_linode() {
  local ip="$1"
  local ssh_key="${MOQX_SSH_KEY:-$HOME/.ssh/id_ed25519}"
  local ssh_user="${MOQX_SSH_USER:-ubuntu}"
  local ssh_opts=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)
  if [[ ! -f "$ssh_key" ]]; then
    ssh_key="$HOME/.ssh/id_rsa"
  fi
  if [[ -f "$ssh_key" ]]; then
    ssh_opts+=(-i "$ssh_key")
  fi
  # Direct first; the web VM often has the Linode deploy key when laptop SSH does not.
  if ssh "${ssh_opts[@]}" "${ssh_user}@${ip}" \
    "sudo ufw allow from ${WEB_IP} to any port ${CANARY_ADMIN_PORT} proto tcp comment 'web canary admin scrape' || true; sudo ufw status | grep -F '${CANARY_ADMIN_PORT}' || true"; then
    return 0
  fi
  echo "direct SSH to ${ip} failed; jumping via web VM ${WEB_IP}" >&2
  ssh "${ssh_opts[@]}" "${ssh_user}@${WEB_IP}" \
    "ssh -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new ${ssh_user}@${ip} \"sudo ufw allow from ${WEB_IP} to any port ${CANARY_ADMIN_PORT} proto tcp comment 'web canary admin scrape' || true\""
}

allow_gcp_instance moq-relay-gcp moq-relay-allow-canary-admin-web
allow_gcp_instance moq-relay-east-gcp moq-relay-east-allow-canary-admin-web
# Linode Cloud Firewall on this host only allows 80/8000/8090. TCP 18000
# times out until that rule exists (web IP only) plus ufw. SSH keys here
# do not match; do not fail the GCP half when Linode is unreachable.
if ! allow_linode 45.79.177.85; then
  echo "Linode 45.79.177.85 :${CANARY_ADMIN_PORT} not opened (SSH key/API token needed)." >&2
  echo "Add Cloud Firewall TCP ${CANARY_ADMIN_PORT} from ${WEB_IP}/32 — leftover :8000 stays public and must not be scraped for :14433." >&2
fi
echo "done"
