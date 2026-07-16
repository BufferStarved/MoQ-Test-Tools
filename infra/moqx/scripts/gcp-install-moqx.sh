#!/usr/bin/env bash
# Install OpenMOQ moqx on the relay VM with Let's Encrypt TLS (sslip.io domain).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <relay-public-ip> [certbot-email]" >&2
  exit 1
fi

RELAY_IP="$1"
DOMAIN="$("$ROOT_DIR/scripts/sslip-domain.sh" "$RELAY_IP")"
CERTBOT_EMAIL="${2:-}"

SSH_USER="${MOQX_SSH_USER:-ubuntu}"
SSH_KEY="${MOQX_SSH_KEY:-$HOME/.ssh/id_ed25519}"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="$HOME/.ssh/id_rsa"
fi

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)
if [[ -f "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi

remote() {
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${RELAY_IP}" "$@"
}

echo "Relay IP:      ${RELAY_IP}"
echo "Relay domain:  ${DOMAIN}"
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

if [[ -z "$CERTBOT_EMAIL" ]]; then
  CERTBOT_EMAIL="$(remote 'grep ^CERTBOT_EMAIL= /opt/moq-test-tools/moqx.env 2>/dev/null | cut -d= -f2- || true')"
fi
if [[ -z "$CERTBOT_EMAIL" ]]; then
  read -r -p "Let's Encrypt email: " CERTBOT_EMAIL
fi

remote "sudo bash -s" <<EOF
set -euo pipefail

DOMAIN="${DOMAIN}"
CERTBOT_EMAIL="${CERTBOT_EMAIL}"
MOQX_PORT=4433
MOQX_PICO_PORT=4434
MOQX_ADMIN_PORT=8000
MOQX_ENDPOINT=/moq-relay

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo \\
    "deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \\
    \$(. /etc/os-release && echo \$VERSION_CODENAME) stable" \\
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin certbot
  systemctl enable --now docker
else
  apt-get update
  apt-get install -y certbot docker-compose-plugin || true
fi

mkdir -p /opt/moqx /etc/letsencrypt
cat >/opt/moqx/.env <<ENVEOF
DOMAIN=\${DOMAIN}
CERTBOT_EMAIL=\${CERTBOT_EMAIL}
MOQX_PORT=\${MOQX_PORT}
MOQX_PICO_PORT=\${MOQX_PICO_PORT}
MOQX_ADMIN_PORT=\${MOQX_ADMIN_PORT}
MOQX_CERTS_DIR=/etc/letsencrypt
MOQX_LOG_LEVEL=0
ENVEOF

if [[ ! -f "/etc/letsencrypt/live/\${DOMAIN}/fullchain.pem" ]]; then
  systemctl stop moqx 2>/dev/null || true
  docker rm -f moqx 2>/dev/null || true
  certbot certonly --standalone --non-interactive --agree-tos \\
    --email "\${CERTBOT_EMAIL}" \\
    -d "\${DOMAIN}"
fi

curl -fsSL https://raw.githubusercontent.com/openmoq/moqx/main/docker/entrypoint.sh -o /opt/moqx/entrypoint.sh
chmod 0755 /opt/moqx/entrypoint.sh

cat >/opt/moqx/docker-compose.yml <<YAMLEOF
name: moqx
services:
  moqx:
    container_name: moqx
    image: ghcr.io/openmoq/moqx:latest
    restart: unless-stopped
    network_mode: host
    privileged: true
    ulimits:
      core: -1
    volumes:
      - /etc/letsencrypt:/certs:ro
      - /opt/moqx/entrypoint.sh:/usr/local/bin/entrypoint.sh:ro
    environment:
      MOQX_CERT: /certs/live/\${DOMAIN}/fullchain.pem
      MOQX_KEY: /certs/live/\${DOMAIN}/privkey.pem
      MOQX_PORT: \${MOQX_PORT}
      MOQX_PICO_PORT: \${MOQX_PICO_PORT}
      MOQX_ADMIN_PORT: \${MOQX_ADMIN_PORT}
      MOQX_ENDPOINT: \${MOQX_ENDPOINT}
      MOQX_BIND_ADDR: 0.0.0.0
      MOQX_LOG_LEVEL: 0
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://127.0.0.1:\${MOQX_ADMIN_PORT}/info"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 15s
YAMLEOF

cd /opt/moqx
docker compose --env-file .env pull
docker compose --env-file .env up -d

cat >/etc/cron.d/moqx-certbot <<CRONEOF
0 3 * * * root certbot renew --quiet --deploy-hook "cd /opt/moqx && docker compose --env-file .env up -d"
CRONEOF

cat >/etc/systemd/system/moqx.service <<UNITEOF
[Unit]
Description=OpenMOQ moqx relay
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/moqx
ExecStart=/usr/bin/docker compose --env-file /opt/moqx/.env up -d
ExecStop=/usr/bin/docker compose --env-file /opt/moqx/.env down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable moqx

sleep 5
curl -sf "http://127.0.0.1:\${MOQX_ADMIN_PORT}/info"
EOF

echo ""
echo "moqx installed."
echo "Relay base URL:      https://${DOMAIN}:4433"
echo "Fingerprint URL:     https://${DOMAIN}:4433/fingerprint"
echo "Publish endpoint:    https://${DOMAIN}:4433/moq-relay"
echo "Health check:        curl http://${RELAY_IP}:8000/info"
