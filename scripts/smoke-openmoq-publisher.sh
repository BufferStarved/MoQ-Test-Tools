#!/usr/bin/env bash
# Side-by-side smoke: pipe ~8s of CMAF fMP4 into a chosen openmoq-publisher
# against the GCP MoQ relay. Does not replace tools/openmoq-publisher.
#
# Example (candidate 0.3.11 without changing the default pin):
#   OPENMOQ_PUBLISHER_VERSION=v0.3.11 ./scripts/smoke-openmoq-publisher.sh
#
# Canary moqx on the relay VM (unused ports, no public firewall):
#   MOQ_SMOKE_REMOTE=moq-relay-gcp \
#   MOQ_SMOKE_RELAY=https://127.0.0.1:14433/moq-relay \
#   MOQ_SMOKE_ADMIN=http://127.0.0.1:18000/info \
#     ./scripts/smoke-openmoq-publisher.sh
#
# Exit 0 only if the publisher process exits cleanly after sending media.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${OPENMOQ_PUBLISHER_VERSION:-v0.3.11}"
REPO="${OPENMOQ_PUBLISHER_REPO:-https://github.com/openmoq/moqxr}"
RELAY="${MOQ_SMOKE_RELAY:-https://34-28-164-90.sslip.io:4433/moq-relay}"
ADMIN="${MOQ_SMOKE_ADMIN:-http://34.28.164.90:8000/info}"
REMOTE="${MOQ_SMOKE_REMOTE:-}"
NS="${MOQ_SMOKE_NAMESPACE:-upgrade-smoke-${VERSION//./}}"
SIDE_DIR="${OPENMOQ_SMOKE_DIR:-$ROOT_DIR/tools/openmoq-publisher-smoke/$VERSION}"
BIN="$SIDE_DIR/bin/openmoq-publisher"
DURATION_SEC="${MOQ_SMOKE_DURATION_SEC:-8}"
TIMEOUT_SEC="${MOQ_SMOKE_TIMEOUT_SEC:-20}"
ZONE="${GCP_ZONE:-us-central1-a}"
DOCKER_IMAGE="${OPENMOQ_PUBLISHER_DOCKER_IMAGE:-ubuntu:24.04}"

export PATH="/opt/homebrew/opt/ffmpeg-full/bin:/opt/homebrew/bin:${PATH:-}"

detect_asset() {
  case "$(uname -s)" in
    Darwin) echo "openmoq-publisher-${VERSION}-macOS.tar.gz" ;;
    Linux) echo "openmoq-publisher-${VERSION}-Linux.tar.gz" ;;
    *) echo "Unsupported OS $(uname -s)" >&2; exit 1 ;;
  esac
}

ensure_binary() {
  if [[ -x "$BIN" ]]; then
    return 0
  fi
  local asset tmp url found
  asset="$(detect_asset)"
  url="$REPO/releases/download/${VERSION}/${asset}"
  tmp="$(mktemp -d)"
  mkdir -p "$SIDE_DIR/bin"
  echo "Downloading $url"
  curl -fsSL "$url" -o "$tmp/$asset"
  tar -xzf "$tmp/$asset" -C "$SIDE_DIR"
  found="$(find "$SIDE_DIR" -type f -name 'openmoq-publisher' | head -n 1)"
  if [[ -z "$found" ]]; then
    echo "openmoq-publisher not found in $asset" >&2
    exit 1
  fi
  install -m 0755 "$found" "$BIN"
  printf '%s\n' "$VERSION" >"$SIDE_DIR/VERSION"
  rm -rf "$tmp"
}

# Canary relays on unused ports are not public. Re-exec this script on the VM
# over IAP so WebTransport hits localhost (no extra firewall).
if [[ -n "$REMOTE" ]]; then
  echo "Re-exec smoke on ${REMOTE} via IAP (relay=$RELAY)"
  gcloud compute scp --zone="$ZONE" --tunnel-through-iap \
    "$ROOT_DIR/scripts/smoke-openmoq-publisher.sh" \
    "ubuntu@${REMOTE}:/tmp/smoke-openmoq-publisher.sh"
  gcloud compute ssh "ubuntu@${REMOTE}" --zone="$ZONE" --tunnel-through-iap --command="
    set -euo pipefail
    export OPENMOQ_PUBLISHER_VERSION='${VERSION}'
    export MOQ_SMOKE_RELAY='${RELAY}'
    export MOQ_SMOKE_ADMIN='${ADMIN}'
    export MOQ_SMOKE_NAMESPACE='${NS}'
    export MOQ_SMOKE_DURATION_SEC='${DURATION_SEC}'
    export MOQ_SMOKE_TIMEOUT_SEC='${TIMEOUT_SEC}'
    export OPENMOQ_SMOKE_DIR='/tmp/openmoq-publisher-smoke/${VERSION}'
    export PATH=\"/usr/local/bin:/usr/bin:\${PATH:-}\"
    bash /tmp/smoke-openmoq-publisher.sh
  "
  exit $?
fi

ensure_binary
if ! "$BIN" --help >/dev/null 2>&1; then
  docker_bin=""
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker_bin="docker"
  elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    docker_bin="sudo -n docker"
  fi
  if [[ "$(uname -s)" == "Linux" && -n "$docker_bin" ]]; then
    echo "Native publisher is not runnable here; wrapping with ${DOCKER_IMAGE} ($docker_bin)"
    real="$SIDE_DIR/bin/openmoq-publisher.real"
    if [[ -x "$BIN" && ! -f "$real" ]]; then
      mv "$BIN" "$real"
    fi
    $docker_bin pull "$DOCKER_IMAGE" >/dev/null
    cat >"$BIN" <<EOF
#!/usr/bin/env bash
set -euo pipefail
REAL="\$(cd "\$(dirname "\$0")" && pwd)/openmoq-publisher.real"
exec ${docker_bin} run --rm -i --network host \\
  -v "\$REAL:/usr/local/bin/openmoq-publisher:ro" \\
  ${DOCKER_IMAGE} \\
  /usr/local/bin/openmoq-publisher "\$@"
EOF
    chmod 0755 "$BIN"
  else
    echo "openmoq-publisher $VERSION failed to run on this host." >&2
    exit 1
  fi
fi
command -v ffmpeg >/dev/null || {
  echo "ffmpeg not found (need ffmpeg-full for AAC/libx264)." >&2
  exit 1
}

echo "Smoke publish: version=$VERSION relay=$RELAY namespace=$NS"
LOG="$(mktemp -t moqxr-smoke.XXXXXX.log)"
FFERR="$(mktemp -t moqxr-smoke-ffmpeg.XXXXXX.err)"

set +e
(
  ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "testsrc=size=640x360:rate=30" \
    -f lavfi -i "sine=f=440:r=48000" \
    -t "$DURATION_SEC" \
    -c:v libx264 -pix_fmt yuv420p -profile:v main -g 30 -keyint_min 30 -sc_threshold 0 \
    -c:a aac -b:a 64k -ar 48000 \
    -f mp4 -movflags cmaf+separate_moof+delay_moov+skip_trailer+frag_keyframe+empty_moov \
    - 2>"$FFERR"
) | "$BIN" \
  --input - \
  --transport webtransport \
  --draft 16 \
  --namespace "$NS" \
  --forward 1 \
  --publish-catalog \
  --endpoint "$RELAY" \
  --insecure \
  --timeout "$TIMEOUT_SEC" \
  >"$LOG" 2>&1
PUB_RC=${PIPESTATUS[1]:-$?}
set -e

echo "publisher_exit=$PUB_RC"
echo "--- publisher log (tail) ---"
tail -n 50 "$LOG" || true
if [[ -s "$FFERR" ]]; then
  echo "--- ffmpeg stderr (tail) ---"
  tail -n 20 "$FFERR" || true
fi

# Soft signal from relay admin (best-effort; counter is process-lifetime).
if curl -fsS -m 3 "$ADMIN" >/dev/null 2>&1; then
  echo "--- relay /info ---"
  curl -fsS -m 3 "$ADMIN"
  echo
fi

rm -f "$LOG" "$FFERR"

if [[ "$PUB_RC" -ne 0 ]]; then
  echo "FAIL: openmoq-publisher $VERSION did not exit cleanly against $RELAY" >&2
  echo "If this is the CONNECT handshake refusal, upgrade moqx before flipping the default pin." >&2
  exit "$PUB_RC"
fi

echo "PASS: openmoq-publisher $VERSION completed a ${DURATION_SEC}s publish to $RELAY"
echo "Next: OPENMOQ_PUBLISHER_VERSION=$VERSION OPENMOQ_PUBLISHER_FORCE=1 ./scripts/install-openmoq-publisher.sh"
echo "Then change the default VERSION in scripts/install-openmoq-publisher.sh after soak."
