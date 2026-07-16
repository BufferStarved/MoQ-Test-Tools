#!/usr/bin/env bash
# Replace the relay TLS cert with a short-lived ECDSA self-signed certificate.
#
# Chrome WebTransport only accepts certificate pinning (serverCertificateHashes) for
# ECDSA certs valid <= 14 days. Let's Encrypt RSA certs fail browser QUIC handshake
# even though openmoq-publisher connects fine with normal TLS verification.
#
# After running this on the relay VM, update MOQ_RELAY_CERT_SHA256 in web/api/main.py
# with the printed SHA-256 fingerprint and restart the dev stack.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <relay-domain>" >&2
  echo "Example: $0 34-28-164-90.sslip.io" >&2
  exit 1
fi

CERT_DIR="/etc/letsencrypt/wt-certs"
COMPOSE_DIR="/opt/moqx"
CONTAINER_CERT="/certs/wt-certs/cert.pem"
CONTAINER_KEY="/certs/wt-certs/privkey.pem"

sudo mkdir -p "$CERT_DIR"
sudo openssl ecparam -name prime256v1 -genkey -noout -out "$CERT_DIR/privkey.pem"
sudo openssl req -new -x509 -key "$CERT_DIR/privkey.pem" -out "$CERT_DIR/cert.pem" -days 14 \
  -subj "/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN}"
sudo chmod 644 "$CERT_DIR/cert.pem"
sudo chmod 600 "$CERT_DIR/privkey.pem"

FINGERPRINT="$(sudo openssl x509 -in "$CERT_DIR/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr '[:upper:]' '[:lower:]')"

if [[ ! -f "$COMPOSE_DIR/docker-compose.yml" ]]; then
  echo "docker-compose.yml not found at $COMPOSE_DIR" >&2
  exit 1
fi

sudo sed -i "s|MOQX_CERT: .*|MOQX_CERT: ${CONTAINER_CERT}|" "$COMPOSE_DIR/docker-compose.yml"
sudo sed -i "s|MOQX_KEY: .*|MOQX_KEY: ${CONTAINER_KEY}|" "$COMPOSE_DIR/docker-compose.yml"

cd "$COMPOSE_DIR"
sudo docker compose --env-file .env up -d

echo ""
echo "WebTransport ECDSA cert installed for ${DOMAIN}"
echo "SHA-256 fingerprint: ${FINGERPRINT}"
echo "Update web/api/main.py MOQ_RELAY_CERT_SHA256[\"${DOMAIN}\"] = \"${FINGERPRINT}\""
echo "Publish with openmoq-publisher --insecure (handled automatically for sslip.io relays)."
