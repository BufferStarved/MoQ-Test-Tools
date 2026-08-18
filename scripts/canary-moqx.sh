#!/usr/bin/env bash
# Stand up a second moqx container on the existing relay VM (unused ports).
# Does NOT replace prod ghcr.io/openmoq/moqx:329b98b on :4433/:8000.
#
# Default canary:
#   UDP 14433 (mvfst / WebTransport)
#   UDP 14434 (picoquic)
#   TCP 18000 (admin)
#
# Usage:
#   ./scripts/canary-moqx.sh              # start + wait healthy
#   ./scripts/canary-moqx.sh status
#   ./scripts/canary-moqx.sh stop
set -euo pipefail

ACTION="${1:-start}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE="${MOQX_CANARY_INSTANCE:-moq-relay-gcp}"
# GHCR tags are short SHAs (no snapshot-latest). 5611457 is current main as of 2026-08-14.
IMAGE="${MOQX_CANARY_IMAGE:-ghcr.io/openmoq/moqx:5611457}"
CANARY_PORT="${MOQX_CANARY_PORT:-14433}"
CANARY_PICO_PORT="${MOQX_CANARY_PICO_PORT:-14434}"
CANARY_ADMIN_PORT="${MOQX_CANARY_ADMIN_PORT:-18000}"
NAME="${MOQX_CANARY_NAME:-moqx-canary}"

remote() {
  gcloud compute ssh "ubuntu@${INSTANCE}" --zone="$ZONE" --tunnel-through-iap --command="$1"
}

case "$ACTION" in
  status)
    remote "echo '=== prod ==='; curl -fsS -m 3 http://127.0.0.1:8000/info; echo; sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' | sed -n '1p;/moqx/p'; echo '=== canary ==='; curl -fsS -m 3 http://127.0.0.1:${CANARY_ADMIN_PORT}/info || echo 'canary admin down'"
    ;;
  stop)
    remote "sudo docker rm -f ${NAME} >/dev/null 2>&1 && echo stopped ${NAME} || echo ${NAME} not running"
    ;;
  start)
    gcloud compute ssh "ubuntu@${INSTANCE}" --zone="$ZONE" --tunnel-through-iap --command="sudo bash -s" <<EOF
set -euo pipefail
IMAGE="${IMAGE}"
NAME="${NAME}"
CANARY_PORT="${CANARY_PORT}"
CANARY_PICO_PORT="${CANARY_PICO_PORT}"
CANARY_ADMIN_PORT="${CANARY_ADMIN_PORT}"

echo "Pulling \$IMAGE ..."
docker pull "\$IMAGE"

# Leave prod (container name moqx, ports 4433/8000) alone.
if docker ps --format '{{.Names}}' | grep -qx moqx; then
  echo "prod moqx still running"
else
  echo "WARNING: prod moqx container is not running" >&2
fi

docker rm -f "\$NAME" >/dev/null 2>&1 || true
docker run -d --name "\$NAME" --network host --restart unless-stopped \\
  -e MOQX_INSECURE=true \\
  -e MOQX_PORT="\$CANARY_PORT" \\
  -e MOQX_PICO_ENABLE=false \\
  -e MOQX_PICO_PORT="\$CANARY_PICO_PORT" \\
  -e MOQX_ADMIN_PORT="\$CANARY_ADMIN_PORT" \\
  -e MOQX_ENDPOINT=/moq-relay \\
  -e MOQX_BIND_ADDR=0.0.0.0 \\
  -e MOQX_THREADS=2 \\
  "\$IMAGE"

for i in \$(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:\${CANARY_ADMIN_PORT}/info" >/tmp/canary-info.json; then
    echo "canary healthy:"
    cat /tmp/canary-info.json; echo
    docker ps --filter name="\$NAME" --format '{{.Names}} {{.Image}} {{.Status}}'
    exit 0
  fi
  sleep 2
done
echo "canary failed to become healthy" >&2
docker logs --tail 80 "\$NAME" >&2 || true
exit 1
EOF
    echo "Canary admin: localhost:${CANARY_ADMIN_PORT} on ${INSTANCE} (SSH hop)"
    echo "Canary WT:    https://127.0.0.1:${CANARY_PORT}/moq-relay (from the VM, --insecure)"
    echo "Prod untouched on :4433 / :8000"
    ;;
  *)
    echo "Usage: $0 [start|status|stop]" >&2
    exit 1
    ;;
esac
