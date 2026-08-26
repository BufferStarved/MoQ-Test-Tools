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
# mediamtx.yml is a bind mount read once at startup, so `compose up -d` alone
# will not pick up an edit. Remember the old digest and only recreate if it moved
# — a restart drops every live HLS/WHEP viewer on the public bench.
CONFIG_BEFORE="$(sudo sha256sum "$INSTALL_DIR/mediamtx.yml" 2>/dev/null | cut -d' ' -f1 || true)"
sudo cp "$MTX_DIR/mediamtx.yml" "$INSTALL_DIR/mediamtx.yml"
sudo cp "$MTX_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
sudo cp "$MTX_DIR/nginx-lldash.conf" "$INSTALL_DIR/nginx-lldash.conf"
sudo cp "$MTX_DIR/scripts/lldash-packager.sh" "$INSTALL_DIR/scripts/lldash-packager.sh"
sudo chmod +x "$INSTALL_DIR/scripts/lldash-packager.sh"

# Advertise the public IP as the only ICE candidate. Interface IPs must stay off
# the wire — ffmpeg WHIP will otherwise try 127.0.0.1 and exit 69 (Conversion
# failed). This is an SDP rewrite, so it is safe on any host.
#
# webrtcLocalUDPAddress is a different thing: MediaMTX hands it to
# net.ListenPacket, so a host part the machine does not own aborts startup with
# EADDRNOTAVAIL and drops LL-HLS/RTMP/SRT too. On GCE the public IP lives on the
# 1:1 NAT, never on the NIC. Rather than pin it, sanitise it: keep whatever the
# repo config ships unless this host cannot bind it, then fall back to wildcard.
sudo python3 - <<PY
import socket
from pathlib import Path

def bindable(host: str) -> bool:
    """Can this host bind the address? Port 0 so a live MediaMTX is not a false negative."""
    if not host:
        return True
    for family in (socket.AF_INET6, socket.AF_INET) if ":" in host else (socket.AF_INET,):
        try:
            with socket.socket(family, socket.SOCK_DGRAM) as sock:
                sock.bind((host, 0))
            return True
        except OSError:
            continue
    return False

def sanitise_ice_udp(value: str) -> str:
    # Drop trailing comments; a blank value legitimately disables the listener.
    addr = value.split("#", 1)[0].strip()
    if not addr:
        return ""
    host = addr.rsplit(":", 1)[0].strip("[]") if ":" in addr else ""
    if bindable(host):
        return addr
    print(f"WARNING: cannot bind ICE UDP host {host!r} here; falling back to :8189")
    return ":8189"

path = Path("${INSTALL_DIR}/mediamtx.yml")
lines = []
seen = set()
for line in path.read_text().splitlines():
    key = line.strip().split(":", 1)[0]
    if key == "webrtcAdditionalHosts":
        lines.append('webrtcAdditionalHosts: ["${PUBLIC_IP}"]')
    elif key == "webrtcIPsFromInterfaces":
        lines.append("webrtcIPsFromInterfaces: no")
    elif key == "webrtcLocalUDPAddress":
        lines.append(f"webrtcLocalUDPAddress: {sanitise_ice_udp(line.split(':', 1)[1])}")
    else:
        lines.append(line)
        continue
    seen.add(key)
if "webrtcAdditionalHosts" not in seen:
    lines.append('webrtcAdditionalHosts: ["${PUBLIC_IP}"]')
if "webrtcIPsFromInterfaces" not in seen:
    lines.append("webrtcIPsFromInterfaces: no")
if "webrtcLocalUDPAddress" not in seen:
    lines.append("webrtcLocalUDPAddress: :8189")
path.write_text("\n".join(lines) + "\n")
print("webrtcAdditionalHosts -> ${PUBLIC_IP}; webrtcIPsFromInterfaces -> no")
PY

CONFIG_AFTER="$(sudo sha256sum "$INSTALL_DIR/mediamtx.yml" | cut -d' ' -f1)"

cd "$INSTALL_DIR"
sudo docker compose pull
if [[ "$CONFIG_BEFORE" != "$CONFIG_AFTER" ]]; then
  echo "mediamtx.yml changed — recreating the container (live viewers will drop)."
  sudo docker compose up -d --force-recreate mediamtx
  sudo docker compose up -d
else
  echo "mediamtx.yml unchanged — leaving the running container alone."
  sudo docker compose up -d
fi

# A rejected listener address is a silent total outage: MediaMTX exits before the
# HLS/RTMP/SRT servers start, so "the site is down" is the only symptom. Prove the
# ICE listener opened *on this run* — the container may have days of scrollback,
# and docker logs needs -a because the stream contains binary bytes.
echo "Waiting for the MediaMTX WebRTC listener..."
for _ in $(seq 1 20); do
  STARTED_AT="$(sudo docker inspect -f '{{.State.StartedAt}}' moq-mediamtx 2>/dev/null || true)"
  if [[ -n "$STARTED_AT" ]] && sudo docker logs --since "$STARTED_AT" moq-mediamtx 2>&1 \
      | grep -aq '\[WebRTC\] listener opened'; then
    ICE_UP=1
    break
  fi
  sleep 1
done
if [[ -z "${ICE_UP:-}" ]]; then
  echo "ERROR: MediaMTX did not open its WebRTC listener. Recent logs:" >&2
  sudo docker logs --tail 40 moq-mediamtx 2>&1 | tail -40 >&2
  echo "ERROR: check webrtcLocalUDPAddress in ${INSTALL_DIR}/mediamtx.yml -- the" >&2
  echo "ERROR: host part must be an address this machine owns (see docs/WEBRTC-ICE.md)." >&2
  exit 1
fi
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
