#!/usr/bin/env bash
# Run ON the GCP VM after uploading the Zixi Linux installer tarball.
set -euo pipefail

INSTALLER_PATH="${1:-}"
INSTALL_DIR="${2:-/opt/zixi_broadcaster-linux64}"

if [[ -z "$INSTALLER_PATH" || ! -f "$INSTALLER_PATH" ]]; then
  echo "Usage: sudo bash zixi-remote-install.sh /path/to/zixi-installer.tar.gz|.tar.xz [install-dir]"
  exit 1
fi

echo "Stopping existing Zixi service (if any)..."
systemctl stop zixibc.service 2>/dev/null || true

echo "Installing Zixi to ${INSTALL_DIR}..."
rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"

case "$INSTALLER_PATH" in
  *.tar.xz) tar -xJf "$INSTALLER_PATH" -C "$(dirname "$INSTALL_DIR")" ;;
  *.tar.gz|*.tgz) tar -xzf "$INSTALLER_PATH" -C "$(dirname "$INSTALL_DIR")" ;;
  *) tar -xf "$INSTALLER_PATH" -C "$(dirname "$INSTALL_DIR")" ;;
esac

if [[ ! -d "$INSTALL_DIR" ]]; then
  echo "Expected install directory not found: $INSTALL_DIR"
  find "$(dirname "$INSTALL_DIR")" -maxdepth 2 -type d
  exit 1
fi

INSTALL_SCRIPT="$(find "$INSTALL_DIR" -maxdepth 2 -type f \( \
  -name 'installMe.sh' \
  -o -name 'install.sh' \
  -o -name 'Install.sh' \
  -o -name 'zixi_install.sh' \
  \) | head -1)"

if [[ -z "$INSTALL_SCRIPT" ]]; then
  echo "Could not find installer script in $INSTALL_DIR"
  find "$INSTALL_DIR" -maxdepth 2 -type f | head -30
  exit 1
fi

echo "Running installer: $INSTALL_SCRIPT"
cd "$INSTALL_DIR"
chmod +x "$INSTALL_SCRIPT"
"$INSTALL_SCRIPT"

echo ""
echo "Opening firewall ports for Zixi (ufw)..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp
  ufw allow 4444/tcp
  ufw allow 1935/tcp
  ufw allow 7777/tcp
  ufw allow 2088/udp
  ufw allow 2088/tcp
  ufw allow 2077/udp
  ufw allow "${SRT_PORT:-10080}"/udp
  ufw allow "${SRT_PORT:-10080}"/tcp
  ufw --force enable || true
fi

PUBLIC_IP="$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || hostname -I | awk '{print $1}')"

echo ""
echo "Zixi installed to ${INSTALL_DIR}"
echo "Service status:"
systemctl is-active zixibc.service || true
echo ""
echo "Next steps:"
echo "  1. Open http://${PUBLIC_IP}:4444/login.html"
echo "  2. Activate your license (requires outbound HTTPS to license.zixi.com)"
echo "  3. Add SRT push input on listening port 2088"
echo "  4. Test from local: srt://${PUBLIC_IP}:2088?mode=caller&latency=200000"
