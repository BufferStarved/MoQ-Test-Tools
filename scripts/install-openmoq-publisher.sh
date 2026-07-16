#!/usr/bin/env bash
# Install the OpenMOQ publisher CLI (moqxr) used to publish ffmpeg fMP4 into moqx relays.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="$ROOT_DIR/tools/openmoq-publisher"
BIN_DIR="$INSTALL_DIR/bin"
VERSION="${OPENMOQ_PUBLISHER_VERSION:-v0.3.2}"
REPO="https://github.com/mondain/moqxr"

detect_platform() {
  local os arch asset
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) asset="openmoq-publisher-${VERSION}-macOS.tar.gz" ;;
    Linux) asset="openmoq-publisher-${VERSION}-Linux.tar.gz" ;;
    *)
      echo "Unsupported OS: $os. Build from source: $REPO" >&2
      exit 1
      ;;
  esac
  echo "$asset"
}

install_from_release() {
  local asset="$1"
  local url="$REPO/releases/download/${VERSION}/${asset}"
  local tmp
  tmp="$(mktemp -d)"

  echo "Downloading $url"
  curl -fsSL "$url" -o "$tmp/$asset"

  rm -rf "$INSTALL_DIR"
  mkdir -p "$BIN_DIR"
  tar -xzf "$tmp/$asset" -C "$INSTALL_DIR"

  local binary
  binary="$(find "$INSTALL_DIR" -type f -name 'openmoq-publisher' | head -n 1)"
  if [[ -z "$binary" ]]; then
    echo "Could not find openmoq-publisher binary in release archive." >&2
    exit 1
  fi

  install -m 0755 "$binary" "$BIN_DIR/openmoq-publisher"
  rm -rf "$tmp"
}

main() {
  if [[ -x "$BIN_DIR/openmoq-publisher" ]]; then
    echo "openmoq-publisher already installed at $BIN_DIR/openmoq-publisher"
    "$BIN_DIR/openmoq-publisher" --help >/dev/null 2>&1 || true
    exit 0
  fi

  install_from_release "$(detect_platform)"
  echo "Installed openmoq-publisher to $BIN_DIR/openmoq-publisher"
  echo "dev.sh will prepend tools/openmoq-publisher/bin to PATH automatically."
}

main "$@"
