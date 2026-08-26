#!/usr/bin/env bash
# Install MediaMTX + ingest-agent on a Linode web host over SSH.
# Does not install the public UI (orchestrator stays on GCP).
#
# Usage:
#   ./infra/linode/scripts/remote-install-mediamtx.sh <public-ip>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PUBLIC_IP="${1:-}"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "Usage: $0 <public-ip>" >&2
  exit 1
fi

SSH_USER="${MEDIAMTX_SSH_USER:-ubuntu}"
SSH_KEY="${MEDIAMTX_SSH_KEY:-$HOME/.ssh/id_ed25519}"
if [[ ! -f "$SSH_KEY" ]]; then
  SSH_KEY="$HOME/.ssh/id_rsa"
fi
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=12)
if [[ -f "$SSH_KEY" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY")
fi

remote() {
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${PUBLIC_IP}" "$@"
}

echo "Waiting for SSH on ${SSH_USER}@${PUBLIC_IP}..."
for _ in $(seq 1 30); do
  if remote "echo ok" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done
if ! remote "echo ok" >/dev/null 2>&1; then
  echo "SSH to ${PUBLIC_IP} failed." >&2
  exit 1
fi

echo "Installing docker + ffmpeg on ${PUBLIC_IP}..."
remote "sudo bash -s" <<'EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
fi
if ! command -v ffmpeg >/dev/null 2>&1 && [[ ! -x /usr/local/bin/ffmpeg ]]; then
  apt-get update
  apt-get install -y ffmpeg
fi
id -u ubuntu >/dev/null 2>&1 && usermod -aG docker ubuntu || true
EOF

echo "Syncing MediaMTX + ingest-agent sources..."
RSH=(ssh "${SSH_OPTS[@]}")
remote "sudo mkdir -p /opt/moq-test-tools/infra/zixi/scripts /opt/moq-test-tools/ingest_agent /tmp/moq-sync && sudo chown -R ${SSH_USER}:${SSH_USER} /tmp/moq-sync"
rsync -az --delete -e "${RSH[*]}" \
  "$REPO_ROOT/infra/mediamtx/" "${SSH_USER}@${PUBLIC_IP}:/tmp/moq-sync/mediamtx/"
rsync -az --delete -e "${RSH[*]}" \
  "$REPO_ROOT/ingest_agent/" "${SSH_USER}@${PUBLIC_IP}:/tmp/moq-sync/ingest_agent/"
rsync -az -e "${RSH[*]}" \
  "$REPO_ROOT/infra/zixi/scripts/install-ingest-agent.sh" \
  "${SSH_USER}@${PUBLIC_IP}:/tmp/moq-sync/install-ingest-agent.sh"
remote "sudo rsync -a --delete /tmp/moq-sync/mediamtx/ /opt/moq-test-tools/infra/mediamtx/"
remote "sudo rsync -a --delete /tmp/moq-sync/ingest_agent/ /opt/moq-test-tools/ingest_agent/"
remote "sudo cp /tmp/moq-sync/install-ingest-agent.sh /opt/moq-test-tools/infra/zixi/scripts/install-ingest-agent.sh"

echo "Starting MediaMTX..."
remote "sudo env PUBLIC_IP=${PUBLIC_IP} bash /opt/moq-test-tools/infra/mediamtx/scripts/install-mediamtx.sh"

echo "Installing ingest-agent..."
remote "sudo bash /opt/moq-test-tools/infra/zixi/scripts/install-ingest-agent.sh"

echo ""
echo "MediaMTX host ${PUBLIC_IP} is up."
echo "  Publish SRT:  srt://${PUBLIC_IP}:8890?streamid=publish:benchmark"
echo "  Play LL-HLS:  http://${PUBLIC_IP}:8888/benchmark/index.m3u8"
echo "  Ingest agent: http://${PUBLIC_IP}:8090/api/v1/health"
echo "  Token stays on the host: sudo grep INGEST_AGENT_TOKEN /etc/moq-ingest-agent.env"
