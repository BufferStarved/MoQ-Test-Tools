#!/usr/bin/env bash
# Install the OpenMOQ publisher CLI (moqxr) used to publish ffmpeg fMP4 into moqx relays.
#
# Prebuilt Linux releases need GLIBC ≥ 2.38 (Ubuntu 24.04+). On older hosts we keep the
# ELF as openmoq-publisher.real and install a Docker (ubuntu:24.04) wrapper.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$ROOT_DIR/tools/openmoq-publisher"
BIN_DIR="$INSTALL_DIR/bin"
VERSION="${OPENMOQ_PUBLISHER_VERSION:-v0.3.4}"
REPO="https://github.com/mondain/moqxr"
DOCKER_IMAGE="${OPENMOQ_PUBLISHER_DOCKER_IMAGE:-ubuntu:24.04}"

detect_platform() {
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin) echo "openmoq-publisher-${VERSION}-macOS.tar.gz" ;;
    Linux) echo "openmoq-publisher-${VERSION}-Linux.tar.gz" ;;
    *)
      echo "Unsupported OS: $os. Build from source: $REPO" >&2
      exit 1
      ;;
  esac
}

install_from_release() {
  local asset="$1"
  local url="$REPO/releases/download/${VERSION}/${asset}"
  local tmp binary
  tmp="$(mktemp -d)"

  echo "Downloading $url"
  curl -fsSL "$url" -o "$tmp/$asset"

  rm -rf "$INSTALL_DIR"
  mkdir -p "$BIN_DIR"
  tar -xzf "$tmp/$asset" -C "$INSTALL_DIR"

  binary="$(find "$INSTALL_DIR" -type f -name 'openmoq-publisher' | head -n 1)"
  if [[ -z "$binary" ]]; then
    echo "Could not find openmoq-publisher binary in release archive." >&2
    exit 1
  fi

  install -m 0755 "$binary" "$BIN_DIR/openmoq-publisher"
  rm -rf "$tmp"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  echo "Installing Docker (required to run openmoq-publisher on this glibc)..."
  curl -fsSL https://get.docker.com | sh
  if id -u ubuntu >/dev/null 2>&1; then
    usermod -aG docker ubuntu || true
  fi
  systemctl enable --now docker || true
}

install_docker_wrapper() {
  local real="$BIN_DIR/openmoq-publisher.real"
  local wrapper="$BIN_DIR/openmoq-publisher"

  if [[ -f "$wrapper" && ! -f "$real" ]]; then
    mv "$wrapper" "$real"
  fi
  if [[ ! -x "$real" ]]; then
    echo "Missing ELF publisher at $real" >&2
    exit 1
  fi

  ensure_docker
  docker pull "$DOCKER_IMAGE" >/dev/null

  cat >"$wrapper" <<EOF
#!/usr/bin/env bash
set -euo pipefail
REAL="\$(cd "\$(dirname "\$0")" && pwd)/openmoq-publisher.real"
exec docker run --rm -i --network host \\
  -v "\$REAL:/usr/local/bin/openmoq-publisher:ro" \\
  ${DOCKER_IMAGE} \\
  /usr/local/bin/openmoq-publisher "\$@"
EOF
  chmod 0755 "$wrapper"

  # Detach stdin: docker -i would otherwise drain a parent `bash -s` install script.
  if ! "$wrapper" --help </dev/null >/dev/null 2>&1; then
    echo "Docker-wrapped openmoq-publisher failed to run." >&2
    exit 1
  fi
  echo "Installed Docker-wrapped openmoq-publisher (image ${DOCKER_IMAGE})"
}

binary_runs_here() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  # Reject binaries rsynced from another OS/arch (e.g. macOS → Linux VM).
  if command -v file >/dev/null 2>&1; then
    local info
    info="$(file -b "$bin" 2>/dev/null || true)"
    case "$(uname -s)" in
      Linux)
        # Accept ELF or our docker wrapper script.
        [[ "$info" == *ELF* || "$info" == *"shell script"* || "$info" == *text* ]] || return 1
        ;;
      Darwin)
        [[ "$info" == *Mach-O* ]] || return 1
        ;;
    esac
  fi
  "$bin" --help </dev/null >/dev/null 2>&1
}

main() {
  if binary_runs_here "$BIN_DIR/openmoq-publisher"; then
    echo "openmoq-publisher already installed at $BIN_DIR/openmoq-publisher"
    return 0
  fi

  if [[ -e "$BIN_DIR/openmoq-publisher" || -e "$BIN_DIR/openmoq-publisher.real" ]]; then
    echo "Replacing unusable openmoq-publisher under $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi

  install_from_release "$(detect_platform)"

  if ! binary_runs_here "$BIN_DIR/openmoq-publisher"; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      echo "Native binary is not runnable on this host (likely glibc too old); wrapping with Docker."
      install_docker_wrapper
    else
      echo "Installed openmoq-publisher but it failed to run." >&2
      exit 1
    fi
  else
    echo "Installed openmoq-publisher to $BIN_DIR/openmoq-publisher"
  fi
  echo "dev.sh will prepend tools/openmoq-publisher/bin to PATH automatically."
}

main "$@"
