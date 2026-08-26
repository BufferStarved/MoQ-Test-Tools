#!/usr/bin/env bash
# Stand up a second moqx container on the existing relay VM (unused ports).
# Does NOT replace prod ghcr.io/openmoq/moqx:329b98b on :4433/:8000.
#
# Default canary:
#   UDP 14433 (mvfst / WebTransport) — public, Let's Encrypt sslip.io cert
#   UDP 14434 (picoquic, disabled unless MOQX_CANARY_PICO=true)
#   TCP 18000 (admin, localhost-only; no public firewall)
#
# Usage:
#   ./scripts/canary-moqx.sh              # firewall (if needed) + start + wait healthy
#   ./scripts/canary-moqx.sh start
#   ./scripts/canary-moqx.sh firewall
#   ./scripts/canary-moqx.sh status
#   ./scripts/canary-moqx.sh stop
set -euo pipefail

ACTION="${1:-start}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE="${MOQX_CANARY_INSTANCE:-moq-relay-gcp}"
# GHCR tags are short SHAs. 75af044 is openmoq/moqx main @ 2026-08-25
# (snapshot-latest / moxygen c6808b5). Do not use this image on leftover :4433.
IMAGE="${MOQX_CANARY_IMAGE:-ghcr.io/openmoq/moqx:75af044}"
CANARY_PORT="${MOQX_CANARY_PORT:-14433}"
CANARY_PICO_PORT="${MOQX_CANARY_PICO_PORT:-14434}"
CANARY_ADMIN_PORT="${MOQX_CANARY_ADMIN_PORT:-18000}"
CANARY_PICO_ENABLE="${MOQX_CANARY_PICO:-false}"
NAME="${MOQX_CANARY_NAME:-moqx-canary}"
FIREWALL_NAME="${MOQX_CANARY_FIREWALL:-moq-relay-allow-canary-d18}"
PUBLIC_HOST="${MOQX_CANARY_HOST:-34-28-164-90.sslip.io}"

remote() {
  gcloud compute ssh "ubuntu@${INSTANCE}" --zone="$ZONE" --tunnel-through-iap --command="$1"
}

ensure_firewall() {
  if gcloud compute firewall-rules describe "$FIREWALL_NAME" --format='value(name)' >/dev/null 2>&1; then
    echo "firewall ${FIREWALL_NAME} already present"
    return 0
  fi
  local network
  network="$(
    gcloud compute instances describe "$INSTANCE" --zone="$ZONE" \
      --format='value(networkInterfaces[0].network)' | awk -F/ '{print $NF}'
  )"
  if [[ -z "$network" ]]; then
    echo "Could not determine VPC network for ${INSTANCE}" >&2
    exit 1
  fi
  echo "Creating firewall ${FIREWALL_NAME} on ${network} (UDP ${CANARY_PORT},${CANARY_PICO_PORT}; prod 4433 untouched)"
  gcloud compute firewall-rules create "$FIREWALL_NAME" \
    --network="$network" \
    --allow="udp:${CANARY_PORT},udp:${CANARY_PICO_PORT}" \
    --source-ranges=0.0.0.0/0 \
    --target-tags=moq-relay \
    --description="Draft-18 moqx canary WebTransport (does not change prod UDP 4433)"
}

case "$ACTION" in
  firewall)
    ensure_firewall
    ;;
  status)
    remote "echo '=== prod ==='; curl -fsS -m 3 http://127.0.0.1:8000/info; echo; sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | sed -n '1p;/moqx/p'; echo '=== canary ==='; curl -fsS -m 3 http://127.0.0.1:${CANARY_ADMIN_PORT}/info || echo 'canary admin down'"
    ;;
  stop)
    remote "sudo docker rm -f ${NAME} >/dev/null 2>&1 && echo stopped ${NAME} || echo ${NAME} not running"
    ;;
  start)
    ensure_firewall
    gcloud compute ssh "ubuntu@${INSTANCE}" --zone="$ZONE" --tunnel-through-iap --command="sudo bash -s" <<EOF
set -euo pipefail
IMAGE="${IMAGE}"
NAME="${NAME}"
CANARY_PORT="${CANARY_PORT}"
CANARY_PICO_PORT="${CANARY_PICO_PORT}"
CANARY_ADMIN_PORT="${CANARY_ADMIN_PORT}"
CANARY_PICO_ENABLE="${CANARY_PICO_ENABLE}"
PUBLIC_HOST="${PUBLIC_HOST}"

DOMAIN="\$(grep '^DOMAIN=' /opt/moqx/.env 2>/dev/null | cut -d= -f2- || true)"
if [[ -z "\$DOMAIN" ]]; then
  DOMAIN="\$PUBLIC_HOST"
fi
HOST_CERT="/etc/letsencrypt/live/\${DOMAIN}/fullchain.pem"
HOST_KEY="/etc/letsencrypt/live/\${DOMAIN}/privkey.pem"
if [[ ! -f "\$HOST_CERT" || ! -f "\$HOST_KEY" ]]; then
  echo "Missing Let's Encrypt cert for \$DOMAIN at \$HOST_CERT" >&2
  ls -la /etc/letsencrypt/live/ >&2 || true
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow "\${CANARY_PORT}/udp" comment "moqx canary d18" || true
  ufw allow "\${CANARY_PICO_PORT}/udp" comment "moqx canary pico" || true
fi

echo "Pulling \$IMAGE ..."
docker pull "\$IMAGE"

# Leave prod (container name moqx, ports 4433/8000) alone.
if docker ps --format '{{.Names}}' | grep -qx moqx; then
  echo "prod moqx still running"
else
  echo "WARNING: prod moqx container is not running" >&2
fi

docker rm -f "\$NAME" >/dev/null 2>&1 || true
# Match prod: mount host LE certs, no MOQX_INSECURE. Chrome playa needs a public cert.
docker run -d --name "\$NAME" --network host --restart unless-stopped \\
  -v /etc/letsencrypt:/certs:ro \\
  -e MOQX_CERT="/certs/live/\${DOMAIN}/fullchain.pem" \\
  -e MOQX_KEY="/certs/live/\${DOMAIN}/privkey.pem" \\
  -e MOQX_PORT="\$CANARY_PORT" \\
  -e MOQX_PICO_ENABLE="\$CANARY_PICO_ENABLE" \\
  -e MOQX_PICO_PORT="\$CANARY_PICO_PORT" \\
  -e MOQX_ADMIN_PORT="\$CANARY_ADMIN_PORT" \\
  -e MOQX_ENDPOINT=/moq-relay \\
  -e MOQX_BIND_ADDR=0.0.0.0 \\
  -e MOQX_THREADS=2 \\
  -e MOQX_LOG_LEVEL=0 \\
  "\$IMAGE"

for i in \$(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:\${CANARY_ADMIN_PORT}/info" >/tmp/canary-info.json; then
    echo "canary healthy:"
    cat /tmp/canary-info.json; echo
    echo "--- /config moqt_versions ---"
    curl -fsS -m 2 "http://127.0.0.1:\${CANARY_ADMIN_PORT}/config" -o /tmp/canary-config.json || true
    python3 - <<'PY' || true
import json
try:
    data = json.load(open("/tmp/canary-config.json"))
    for listener in data.get("listeners") or []:
        print(f"{listener.get('name')} {listener.get('address')} moqt_versions={listener.get('moqt_versions')!r} insecure={((listener.get('tls') or {}).get('insecure'))}")
except Exception as exc:
    print("config parse failed:", exc)
PY
    docker logs --tail 40 "\$NAME" 2>&1 | grep -Ei 'moqt|alpn|draft|listen|cert' || true
    docker ps --filter name="\$NAME" --format '{{.Names}} {{.Image}} {{.Status}}'
    echo "prod moqx:"
    docker ps --filter name=^moqx\$ --format '{{.Names}} {{.Image}} {{.Status}}' || true
    exit 0
  fi
  sleep 2
done
echo "canary failed to become healthy" >&2
docker logs --tail 80 "\$NAME" >&2 || true
exit 1
EOF
    echo "Canary admin: localhost:${CANARY_ADMIN_PORT} on ${INSTANCE} (SSH hop, not public)"
    echo "Canary WT:    https://${PUBLIC_HOST}:${CANARY_PORT}/moq-relay"
    echo "Prod untouched on :4433 / :8000 (ghcr.io/openmoq/moqx:329b98b)"
    ;;
  *)
    echo "Usage: $0 [start|status|stop|firewall]" >&2
    exit 1
    ;;
esac
