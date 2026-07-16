#!/usr/bin/env bash
# Install the MoQ ingest HTTP agent on a Zixi ingest VM.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo"
  exit 1
fi

INSTALL_ROOT="${1:-/opt/moq-ingest-agent}"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
TOKEN_FILE="/etc/moq-ingest-agent.env"

if [[ ! -f "$REPO_DIR/ingest_agent/main.py" ]]; then
  echo "Missing ingest_agent sources at $REPO_DIR/ingest_agent"
  exit 1
fi

apt-get update
apt-get install -y python3 python3-pip python3-venv

mkdir -p "$INSTALL_ROOT"
rsync -a --delete "$REPO_DIR/ingest_agent/" "$INSTALL_ROOT/"

python3 -m venv "$INSTALL_ROOT/venv"
"$INSTALL_ROOT/venv/bin/pip" install -q -r "$INSTALL_ROOT/requirements.txt"

if [[ ! -f "$TOKEN_FILE" ]]; then
  TOKEN="$(python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
)"
  cat > "$TOKEN_FILE" <<EOF
INGEST_AGENT_TOKEN=${TOKEN}
INGEST_AGENT_PORT=8090
INGEST_RECORDING_DIR=/opt/zixi_broadcaster-linux64
INGEST_AGENT_WORK_DIR=/var/lib/moq-ingest-agent
INGEST_FFMPEG_BIN=/usr/local/bin/ffmpeg
EOF
  chmod 600 "$TOKEN_FILE"
  echo "Generated agent token in $TOKEN_FILE"
else
  echo "Using existing $TOKEN_FILE"
fi

cat > /etc/systemd/system/moq-ingest-agent.service <<EOF
[Unit]
Description=MoQ ingest HTTP agent
After=network.target

[Service]
Type=simple
EnvironmentFile=$TOKEN_FILE
WorkingDirectory=$INSTALL_ROOT
ExecStart=$INSTALL_ROOT/venv/bin/uvicorn main:app --host 0.0.0.0 --port \${INGEST_AGENT_PORT}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /var/lib/moq-ingest-agent
systemctl daemon-reload
systemctl enable moq-ingest-agent.service
systemctl restart moq-ingest-agent.service

echo ""
echo "Ingest agent installed."
echo "Health: curl http://127.0.0.1:8090/api/v1/health"
echo "Set this on your hosted web app:"
echo "  export INGEST_AGENT_TOKEN=\$(sudo grep INGEST_AGENT_TOKEN $TOKEN_FILE | cut -d= -f2)"
echo ""
systemctl --no-pager status moq-ingest-agent.service | head -10
