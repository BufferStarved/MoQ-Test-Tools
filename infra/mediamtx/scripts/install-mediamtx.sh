#!/usr/bin/env bash
# Install / refresh MediaMTX (Docker) + CMAF LL-DASH packager sidecar.
#
# Usage:
#   ./infra/mediamtx/scripts/install-mediamtx.sh
#   PUBLIC_IP=34.9.217.178 ./infra/mediamtx/scripts/install-mediamtx.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MTX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${MTX_INSTALL_DIR:-/opt/moq-mediamtx}"
PUBLIC_IP="${PUBLIC_IP:-}"

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || true)"
fi
if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(curl -4 -s --max-time 5 icanhazip.com 2>/dev/null || true)"
fi
if [[ -z "$PUBLIC_IP" ]]; then
  echo "Set PUBLIC_IP to this host's public address (needed for WebRTC ICE)." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required." >&2
  exit 1
fi

FFMPEG_BIN="$(command -v ffmpeg || true)"
if [[ -z "$FFMPEG_BIN" && -x /usr/local/bin/ffmpeg ]]; then
  FFMPEG_BIN=/usr/local/bin/ffmpeg
fi
if [[ -z "$FFMPEG_BIN" ]]; then
  echo "ffmpeg is required on the host for the LL-DASH packager." >&2
  exit 1
fi

echo "Installing MediaMTX into ${INSTALL_DIR} (public IP ${PUBLIC_IP})..."
sudo mkdir -p "$INSTALL_DIR/dash" "$INSTALL_DIR/scripts" /run/moq-mediamtx-lldash
sudo cp "$MTX_DIR/mediamtx.yml" "$INSTALL_DIR/mediamtx.yml"
sudo cp "$MTX_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
sudo cp "$MTX_DIR/nginx-lldash.conf" "$INSTALL_DIR/nginx-lldash.conf"
sudo cp "$MTX_DIR/scripts/lldash-packager.sh" "$INSTALL_DIR/scripts/lldash-packager.sh"
sudo chmod +x "$INSTALL_DIR/scripts/lldash-packager.sh"

# Pin ICE host to the public IP.
sudo python3 - <<PY
from pathlib import Path
path = Path("${INSTALL_DIR}/mediamtx.yml")
text = path.read_text()
lines = []
replaced = False
for line in text.splitlines():
    if line.strip().startswith("webrtcAdditionalHosts:"):
        lines.append(f'webrtcAdditionalHosts: ["${PUBLIC_IP}"]')
        replaced = True
    else:
        lines.append(line)
if not replaced:
    lines.append(f'webrtcAdditionalHosts: ["${PUBLIC_IP}"]')
path.write_text("\n".join(lines) + "\n")
print("webrtcAdditionalHosts -> ${PUBLIC_IP}")
PY

cd "$INSTALL_DIR"
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps

# systemd unit for ffmpeg LL-DASH packager (host ffmpeg → nginx :8891)
sudo tee /etc/systemd/system/moq-mediamtx-lldash.service >/dev/null <<EOF
[Unit]
Description=MediaMTX CMAF LL-DASH packager (ffmpeg sidecar)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=MTX_API=http://127.0.0.1:9997
Environment=DASH_ROOT=${INSTALL_DIR}/dash
Environment=PATHS=benchmark
Environment=FFMPEG=${FFMPEG_BIN}
Environment=STATE_DIR=/run/moq-mediamtx-lldash
ExecStart=${INSTALL_DIR}/scripts/lldash-packager.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now moq-mediamtx-lldash.service
sudo systemctl restart moq-mediamtx-lldash.service || true

echo ""
echo "MediaMTX + LL-DASH origin is up."
echo "  Publish SRT:  srt://${PUBLIC_IP}:8890?streamid=publish:benchmark"
echo "  Publish RTMP: rtmp://${PUBLIC_IP}:1935/benchmark"
echo "  Publish WHIP: http://${PUBLIC_IP}:8889/benchmark/whip"
echo "  Play LL-HLS:  http://${PUBLIC_IP}:8888/benchmark/index.m3u8"
echo "  Play LL-DASH: http://${PUBLIC_IP}:8891/benchmark/manifest.mpd"
echo "  Play WHEP:    http://${PUBLIC_IP}:8889/benchmark/whep"
echo ""
echo "Open firewall (GCP example — include 8891 for LL-DASH):"
echo "  gcloud compute firewall-rules create moq-web-mediamtx \\"
echo "    --network=moq-web-vpc \\"
echo "    --allow=tcp:1935,tcp:8554,tcp:8888,tcp:8889,tcp:8891,udp:8890,udp:8189 \\"
echo "    --target-tags=moq-web --source-ranges=0.0.0.0/0"
