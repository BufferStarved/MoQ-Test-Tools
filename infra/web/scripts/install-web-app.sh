#!/usr/bin/env bash
# Sync and install the MoQ web app on a GCP VM behind Caddy (HTTPS).
#
# Usage:
#   infra/web/scripts/install-web-app.sh <web-public-ip> [domain]
#
# Optional env:
#   WEB_SSH_USER, WEB_SSH_KEY
#   INGEST_AGENT_HOST (default ubuntu@35.222.33.58)
#   INGEST_SSH_KEY
#   GIT_REMOTE (default https://github.com/BufferStarved/MoQ-Test-Tools.git)
#   GIT_REF (default main)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
WEB_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <web-public-ip> [domain]" >&2
  exit 1
fi

WEB_IP="$1"
DOMAIN="${2:-moq.sean-mccarthy.net}"
INSTALL_ROOT="/opt/moq-test-tools"
ENV_FILE="/etc/moq-web.env"
SERVICE_NAME="moq-web"

SSH_USER="${WEB_SSH_USER:-ubuntu}"
SSH_KEY="${WEB_SSH_KEY:-$HOME/.ssh/id_ed25519}"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="$HOME/.ssh/id_rsa"
fi

INGEST_HOST="${INGEST_AGENT_HOST:-ubuntu@35.222.33.58}"
INGEST_KEY="${INGEST_SSH_KEY:-$SSH_KEY}"
GIT_REMOTE="${GIT_REMOTE:-https://github.com/BufferStarved/MoQ-Test-Tools.git}"
GIT_REF="${GIT_REF:-main}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes)
if [[ -f "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi

remote() {
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${WEB_IP}" "$@"
}

echo "Web IP:   ${WEB_IP}"
echo "Domain:   ${DOMAIN}"
echo "Waiting for SSH..."
for _ in $(seq 1 36); do
  if remote "echo ok" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
if ! remote "echo ok" >/dev/null 2>&1; then
  echo "SSH to ${WEB_IP} failed." >&2
  exit 1
fi

echo "Fetching ingest agent token from ${INGEST_HOST}..."
INGEST_TOKEN="$(
  ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -i "$INGEST_KEY" \
    "$INGEST_HOST" \
    'sudo grep ^INGEST_AGENT_TOKEN= /etc/moq-ingest-agent.env | cut -d= -f2-' \
    | tr -d '\r'
)"
if [[ -z "$INGEST_TOKEN" ]]; then
  echo "Could not read INGEST_AGENT_TOKEN from ${INGEST_HOST}." >&2
  exit 1
fi

# Zixi API credentials (required so each SRT push can delete+recreate the input;
# without this, HLS loops the previous encode's last segment).
read_local_env() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi
  if [[ -f "$ROOT_DIR/.env" ]]; then
    local line
    line="$(grep -E "^${key}=" "$ROOT_DIR/.env" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      printf '%s' "${line#*=}"
    fi
  fi
}
ZIXI_API_BASE="$(read_local_env ZIXI_API_BASE)"
ZIXI_API_USER="$(read_local_env ZIXI_API_USER)"
ZIXI_API_PASSWORD="$(read_local_env ZIXI_API_PASSWORD)"
if [[ -z "$ZIXI_API_BASE" ]]; then
  ZIXI_API_BASE="http://35.222.33.58:4444"
fi
if [[ -z "$ZIXI_API_USER" ]]; then
  ZIXI_API_USER="admin"
fi
if [[ -z "$ZIXI_API_PASSWORD" ]]; then
  echo "WARNING: ZIXI_API_PASSWORD not set in env or $ROOT_DIR/.env — SRT HLS reset will be skipped." >&2
fi

GCP_METRICS_PROJECT="$(read_local_env GCP_METRICS_PROJECT)"
GCP_METRICS_ZONE="$(read_local_env GCP_METRICS_ZONE)"
GCP_INSTANCE_ZIXI="$(read_local_env GCP_INSTANCE_ZIXI)"
GCP_INSTANCE_MOQX="$(read_local_env GCP_INSTANCE_MOQX)"
if [[ -z "$GCP_METRICS_ZONE" ]]; then
  GCP_METRICS_ZONE="us-central1-a"
fi
if [[ -z "$GCP_INSTANCE_ZIXI" ]]; then
  GCP_INSTANCE_ZIXI="moq-zixi-gcp"
fi
if [[ -z "$GCP_INSTANCE_MOQX" ]]; then
  GCP_INSTANCE_MOQX="moq-relay-gcp"
fi
if [[ -z "$GCP_METRICS_PROJECT" ]]; then
  echo "WARNING: GCP_METRICS_PROJECT not set — Cloud Monitoring server metrics disabled until configured." >&2
fi

echo "Syncing local repo to ${WEB_IP}:${INSTALL_ROOT} (preferred over git clone)..."
remote "sudo mkdir -p ${INSTALL_ROOT} && sudo chown ${SSH_USER}:${SSH_USER} ${INSTALL_ROOT}"
rsync -az --delete \
  --exclude '.git' \
  --exclude 'venv' \
  --exclude '.venv' \
  --exclude 'node_modules' \
  --exclude '.pnpm-store' \
  --exclude 'results' \
  --exclude 'uploads' \
  --exclude 'web/frontend/dist' \
  --exclude 'tools/moq5' \
  --exclude 'tools/openmoq-publisher' \
  --exclude 'tools/*/node_modules' \
  --exclude 'infra/**/.terraform' \
  --exclude 'infra/**/tfplan' \
  --exclude 'infra/**/terraform.tfvars' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${ROOT_DIR}/" \
  "${SSH_USER}@${WEB_IP}:${INSTALL_ROOT}/"

# Fallback clone marker if rsync left an empty tree (should not happen)
remote "test -f ${INSTALL_ROOT}/requirements.txt"

remote "sudo bash -s" <<EOF
set -euo pipefail

DOMAIN="${DOMAIN}"
INSTALL_ROOT="${INSTALL_ROOT}"
ENV_FILE="${ENV_FILE}"
SERVICE_NAME="${SERVICE_NAME}"
INGEST_TOKEN="${INGEST_TOKEN}"
ZIXI_API_BASE="${ZIXI_API_BASE}"
ZIXI_API_USER="${ZIXI_API_USER}"
ZIXI_API_PASSWORD="${ZIXI_API_PASSWORD}"
GCP_METRICS_PROJECT="${GCP_METRICS_PROJECT}"
GCP_METRICS_ZONE="${GCP_METRICS_ZONE}"
GCP_INSTANCE_ZIXI="${GCP_INSTANCE_ZIXI}"
GCP_INSTANCE_MOQX="${GCP_INSTANCE_MOQX}"
GIT_REMOTE="${GIT_REMOTE}"
GIT_REF="${GIT_REF}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
  python3 python3-pip python3-venv \
  build-essential git openssl \
  srt-tools

# Node 22 (frontend build)
if ! command -v node >/dev/null 2>&1 || [[ "\$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy (auto HTTPS)
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update
  apt-get install -y caddy
fi

# ffmpeg with libvmaf (encoder VMAF on this host)
if [[ -x "${INSTALL_ROOT}/infra/zixi/scripts/install-ingest-vmaf.sh" ]]; then
  bash "${INSTALL_ROOT}/infra/zixi/scripts/install-ingest-vmaf.sh" || true
fi
if [[ ! -x /usr/local/bin/ffmpeg ]]; then
  apt-get install -y ffmpeg || true
fi
FFMPEG_BIN="/usr/local/bin/ffmpeg"
if [[ ! -x "\$FFMPEG_BIN" ]]; then
  FFMPEG_BIN="\$(command -v ffmpeg || true)"
fi
if [[ -z "\$FFMPEG_BIN" ]]; then
  echo "ERROR: ffmpeg not found after install" >&2
  exit 1
fi

cd "\$INSTALL_ROOT"

# Python deps
python3 -m venv "\$INSTALL_ROOT/.venv"
"\$INSTALL_ROOT/.venv/bin/pip" install -q -U pip
"\$INSTALL_ROOT/.venv/bin/pip" install -q -r "\$INSTALL_ROOT/requirements.txt"

# openmoq-publisher: isolate stdin so a docker -i wrapper cannot drain this `bash -s` script.
echo "Ensuring openmoq-publisher..."
bash "\$INSTALL_ROOT/scripts/install-openmoq-publisher.sh" </dev/null || true

# Frontend production build (vite is a devDependency — need full install to build)
echo "Building frontend..."
cd "\$INSTALL_ROOT/web/frontend"
npm ci
npm run build
cd "\$INSTALL_ROOT"
test -f web/frontend/dist/index.html
echo "Frontend build OK."

mkdir -p "\$INSTALL_ROOT/results" "\$INSTALL_ROOT/uploads"
# Service runs as ubuntu; rsync often lands files owned by the deploy SSH user.
chown -R ubuntu:ubuntu "\$INSTALL_ROOT/results" "\$INSTALL_ROOT/uploads" || true
# Keep app tree readable/executable by the service account after sean/rsync deploys.
chown -R ubuntu:ubuntu "\$INSTALL_ROOT/src" "\$INSTALL_ROOT/web" "\$INSTALL_ROOT/.venv" 2>/dev/null || true

PUB_BIN="\$INSTALL_ROOT/tools/openmoq-publisher/bin"
cat > "\$ENV_FILE" <<ENVEOF
INGEST_AGENT_TOKEN=\${INGEST_TOKEN}
INGEST_AGENT_PORT=8090
ZIXI_API_BASE=\${ZIXI_API_BASE}
ZIXI_API_USER=\${ZIXI_API_USER}
ZIXI_API_PASSWORD=\${ZIXI_API_PASSWORD}
GCP_METRICS_ENABLED=1
GCP_METRICS_PROJECT=\${GCP_METRICS_PROJECT}
GCP_METRICS_ZONE=\${GCP_METRICS_ZONE}
GCP_INSTANCE_ZIXI=\${GCP_INSTANCE_ZIXI}
GCP_INSTANCE_MOQX=\${GCP_INSTANCE_MOQX}
FFMPEG=\${FFMPEG_BIN}
PATH=\${PUB_BIN}:/usr/local/bin:/usr/bin:/bin
PYTHONPATH=\${INSTALL_ROOT}/src:\${INSTALL_ROOT}/web/api
MEDIAMTX_LOOPBACK_PUBLISH=1
# Local publisher agent is a laptop/dev feature — keep off on the hosted web VM.
LOCAL_PUBLISHER_ENABLED=1
LOCAL_PUBLISHER_TOKEN=dev-local-publisher
ENVEOF
chmod 600 "\$ENV_FILE"

cat >/etc/systemd/system/\${SERVICE_NAME}.service <<UNITEOF
[Unit]
Description=MoQ Test Tools web API + SPA
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=\${INSTALL_ROOT}
EnvironmentFile=\${ENV_FILE}
ExecStart=\${INSTALL_ROOT}/.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --app-dir \${INSTALL_ROOT}/web/api
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF

cat >/etc/caddy/Caddyfile <<CADDYEOF
\${DOMAIN} {
	encode gzip
	reverse_proxy 127.0.0.1:8000
}
CADDYEOF

systemctl daemon-reload
systemctl enable --now \${SERVICE_NAME}.service
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

sleep 2
curl -fsS http://127.0.0.1:8000/api/health || true
echo ""
systemctl --no-pager status \${SERVICE_NAME}.service | head -12
echo ""
echo "Installed. Public URL: https://\${DOMAIN}"
echo "Ensure DNS A \${DOMAIN} -> \$(curl -4 -s ifconfig.me || true)"
EOF

echo ""
echo "Done."
echo "Verify (after DNS A ${DOMAIN} -> ${WEB_IP}):"
echo "  curl -fsS https://${DOMAIN}/api/health"
echo "  open https://${DOMAIN}"
