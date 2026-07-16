#!/usr/bin/env bash
# Build moq5-fmp4-record (relay-side MoQ subscriber recorder).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOQ5_DIR="$ROOT_DIR/tools/moq5"
DEPS_DIR="$ROOT_DIR/tools/deps"
INSTALL_PREFIX="$MOQ5_DIR/install"
RECORDER_BIN="$ROOT_DIR/tools/moq5-recorder/bin/moq5-fmp4-record"
PUBLISHER_BIN="$ROOT_DIR/tools/moq5-publisher/bin/moq5-fmp4-publish"

is_native_binary() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  if [[ "$(uname -s)" == "Linux" ]]; then
    file "$bin" | grep -q 'ELF'
    return
  fi
  return 0
}

find_cmake() {
  if command -v cmake >/dev/null 2>&1; then
    command -v cmake
    return 0
  fi
  for candidate in /opt/homebrew/bin/cmake /usr/local/bin/cmake; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo "cmake not found. Install CMake 3.20+ and re-run." >&2
  exit 1
}

CMAKE_BIN="$(find_cmake)"

if ! is_native_binary "$PUBLISHER_BIN"; then
  echo "moq5 publisher missing or wrong architecture; building moq5..."
  rm -f "$PUBLISHER_BIN"
  rm -rf "$INSTALL_PREFIX" "$MOQ5_DIR/build-wt"
  "$ROOT_DIR/scripts/install-moq5.sh"
fi

build_recorder() {
  local build_dir="$ROOT_DIR/tools/moq5-recorder/build"
  rm -rf "$build_dir"
  "$CMAKE_BIN" -S "$ROOT_DIR/tools/moq5-recorder" -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="$INSTALL_PREFIX" \
    -DMOQ5_PREFIX="$INSTALL_PREFIX" \
    -DMOQ_PICOQUIC_SOURCE_DIR="$DEPS_DIR/picoquic" \
    -DMOQ_PICOTLS_PREFIX="$DEPS_DIR/picotls/build"
  "$CMAKE_BIN" --build "$build_dir" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)"
  install -d "$(dirname "$RECORDER_BIN")"
  install -m 0755 "$build_dir/moq5-fmp4-record" "$RECORDER_BIN"
}

main() {
  if is_native_binary "$RECORDER_BIN"; then
    echo "moq5-fmp4-record already installed at $RECORDER_BIN"
    exit 0
  fi
  if [[ -e "$RECORDER_BIN" ]]; then
    echo "Removing non-native recorder at $RECORDER_BIN"
    rm -f "$RECORDER_BIN"
  fi

  build_recorder
  echo "Installed moq5-fmp4-record to $RECORDER_BIN"
}

main "$@"
