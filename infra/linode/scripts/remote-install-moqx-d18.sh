#!/usr/bin/env bash
# Install draft-18 moqx canary on UDP 14433 only. Does not start leftover :4433.
#
# Usage:
#   ./infra/linode/scripts/remote-install-moqx-d18.sh <relay-public-ip> [certbot-email]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RELAY_IP="${1:-}"
CERTBOT_EMAIL="${2:-${CERTBOT_EMAIL:-admin@sean-mccarthy.net}}"
if [[ -z "$RELAY_IP" ]]; then
  echo "Usage: $0 <relay-public-ip> [certbot-email]" >&2
  exit 1
fi

DOMAIN="${RELAY_IP//./-}.sslip.io"
IMAGE="${MOQX_CANARY_IMAGE:-ghcr.io/openmoq/moqx:75af044}"
CANARY_PORT="${MOQX_CANARY_PORT:-14433}"
CANARY_PICO_PORT="${MOQX_CANARY_PICO_PORT:-14434}"
CANARY_ADMIN_PORT="${MOQX_CANARY_ADMIN_PORT:-18000}"
NAME="${MOQX_CANARY_NAME:-moqx-canary}"

SSH_USER="${MOQX_SSH_USER:-ubuntu}"
SSH_KEY="${MOQX_SSH_KEY:-$HOME/.ssh/id_ed25519}"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="$HOME/.ssh/id_rsa"
fi
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12)
if [[ -f "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi

remote() {
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${RELAY_IP}" "$@"
}

echo "Relay IP:     ${RELAY_IP}"
echo "Relay domain: ${DOMAIN}"
echo "Image:        ${IMAGE}  UDP :${CANARY_PORT}"
echo "Waiting for SSH..."
for _ in $(seq 1 30); do
  if remote "echo ok" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
if ! remote "echo ok" >/dev/null 2>&1; then
  echo "SSH to ${RELAY_IP} failed." >&2
  exit 1
fi

remote "sudo bash -s" <<EOF
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DOMAIN="${DOMAIN}"
CERTBOT_EMAIL="${CERTBOT_EMAIL}"
IMAGE="${IMAGE}"
NAME="${NAME}"
CANARY_PORT="${CANARY_PORT}"
CANARY_PICO_PORT="${CANARY_PICO_PORT}"
CANARY_ADMIN_PORT="${CANARY_ADMIN_PORT}"

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \$(. /etc/os-release && echo \$VERSION_CODENAME) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin certbot
  systemctl enable --now docker
else
  apt-get update
  apt-get install -y certbot || true
fi

mkdir -p /opt/moqx /etc/letsencrypt
cat >/opt/moqx/.env <<ENVEOF
DOMAIN=\${DOMAIN}
CERTBOT_EMAIL=\${CERTBOT_EMAIL}
MOQX_PORT=\${CANARY_PORT}
MOQX_PICO_PORT=\${CANARY_PICO_PORT}
MOQX_ADMIN_PORT=\${CANARY_ADMIN_PORT}
MOQX_CERTS_DIR=/etc/letsencrypt
MOQX_LOG_LEVEL=0
ENVEOF

if [[ ! -f "/etc/letsencrypt/live/\${DOMAIN}/fullchain.pem" ]]; then
  # Do not start leftover :4433. Free :80 only for HTTP-01.
  docker rm -f moqx 2>/dev/null || true
  certbot certonly --standalone --non-interactive --agree-tos \\
    --email "\${CERTBOT_EMAIL}" \\
    -d "\${DOMAIN}"
fi

echo "Pulling \${IMAGE} ..."
docker pull "\${IMAGE}"
docker rm -f "\${NAME}" >/dev/null 2>&1 || true
docker run -d --name "\${NAME}" --network host --restart unless-stopped \\
  -v /etc/letsencrypt:/certs:ro \\
  -e MOQX_CERT="/certs/live/\${DOMAIN}/fullchain.pem" \\
  -e MOQX_KEY="/certs/live/\${DOMAIN}/privkey.pem" \\
  -e MOQX_PORT="\${CANARY_PORT}" \\
  -e MOQX_PICO_ENABLE=false \\
  -e MOQX_PICO_PORT="\${CANARY_PICO_PORT}" \\
  -e MOQX_ADMIN_PORT="\${CANARY_ADMIN_PORT}" \\
  -e MOQX_ENDPOINT=/moq-relay \\
  -e MOQX_BIND_ADDR=0.0.0.0 \\
  -e MOQX_THREADS=2 \\
  -e MOQX_LOG_LEVEL=0 \\
  "\${IMAGE}"

cat >/etc/cron.d/moqx-certbot <<CRONEOF
0 3 * * * root certbot renew --quiet --deploy-hook "docker restart ${NAME}"
CRONEOF

for i in \$(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:\${CANARY_ADMIN_PORT}/info" >/tmp/canary-info.json; then
    echo "canary healthy:"
    cat /tmp/canary-info.json; echo
    docker ps --filter name="\${NAME}" --format '{{.Names}} {{.Image}} {{.Status}}'
    if docker ps --format '{{.Names}}' | grep -qx moqx; then
      echo "WARNING: leftover moqx container is running — leave :4433 off these new hosts" >&2
    fi
    exit 0
  fi
  sleep 2
done
echo "canary failed to become healthy" >&2
docker logs --tail 80 "\${NAME}" >&2 || true
exit 1
EOF

echo ""
echo "Draft-18 canary is up."
echo "  WT:     https://${DOMAIN}:${CANARY_PORT}/moq-relay"
echo "  Admin:  localhost:${CANARY_ADMIN_PORT} on ${RELAY_IP} (SSH hop)"
echo "  Leftover :4433 was not installed."
