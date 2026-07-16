#!/usr/bin/env bash
# Build libmoq (moq5) with WebTransport and the fMP4 stdin publisher used by ffmpeg pipes.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MOQ5_DIR="$ROOT_DIR/tools/moq5"
DEPS_DIR="$ROOT_DIR/tools/deps"
INSTALL_PREFIX="$MOQ5_DIR/install"
PUBLISHER_BIN="$ROOT_DIR/tools/moq5-publisher/bin/moq5-fmp4-publish"
MOQ5_REPO="${MOQ5_REPO:-https://github.com/openmoq/moq5.git}"
MOQ5_REF="${MOQ5_REF:-main}"
PICOQUIC_REPO="${PICOQUIC_REPO:-https://github.com/private-octopus/picoquic.git}"
PICOTLS_REPO="${PICOTLS_REPO:-https://github.com/h2o/picotls.git}"

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
  echo "cmake not found. Install CMake 3.20+ (brew install cmake) and re-run." >&2
  exit 1
}

CMAKE_BIN="$(find_cmake)"

ensure_prerequisites() {
  local missing=()
  local brew_install=()

  # Homebrew tools are often missing from non-login shells.
  export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"

  if ! command -v pkg-config >/dev/null 2>&1; then
    missing+=(pkg-config)
    brew_install+=(pkg-config)
  fi

  if ! pkg-config --exists openssl 2>/dev/null; then
    if [[ ! -d /opt/homebrew/opt/openssl && ! -d /usr/local/opt/openssl ]]; then
      missing+=(openssl)
      brew_install+=(openssl)
    fi
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Missing build dependencies: ${missing[*]}" >&2
    if command -v brew >/dev/null 2>&1; then
      echo "Install them with:" >&2
      echo "  brew install cmake ${brew_install[*]}" >&2
    else
      echo "Install pkg-config and OpenSSL development files, then re-run." >&2
    fi
    exit 1
  fi

  # Help CMake find Homebrew OpenSSL when pkg-config alone is not enough.
  for openssl_prefix in /opt/homebrew/opt/openssl /usr/local/opt/openssl; do
    if [[ -d "$openssl_prefix" ]]; then
      export OPENSSL_ROOT_DIR="$openssl_prefix"
      export PKG_CONFIG_PATH="${openssl_prefix}/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
      break
    fi
  done
}

clone_dep() {
  local name="$1"
  local repo="$2"
  local dest="$DEPS_DIR/$name"
  if [[ ! -d "$dest/.git" ]]; then
    if [[ -d "$dest" ]]; then
      echo "Replacing non-git $name checkout at $dest"
      rm -rf "$dest"
    fi
    mkdir -p "$DEPS_DIR"
    echo "Cloning $name..."
    git clone --depth 1 "$repo" "$dest"
  fi
  echo "Updating $name submodules..."
  git -C "$dest" submodule update --init --recursive --depth 1
}

ensure_moq5() {
  if [[ -d "$MOQ5_DIR/.git" ]]; then
    return 0
  fi
  if [[ -d "$MOQ5_DIR" ]]; then
    echo "Replacing non-git moq5 checkout at $MOQ5_DIR"
    rm -rf "$MOQ5_DIR"
  fi
  echo "Cloning moq5 into $MOQ5_DIR"
  git clone --depth 1 --branch "$MOQ5_REF" "$MOQ5_REPO" "$MOQ5_DIR"
}

build_picotls() {
  local ptls_build="$DEPS_DIR/picotls/build"
  if [[ -f "$ptls_build/libpicotls.a" || -f "$ptls_build/libpicotls.dylib" ]]; then
    if file "$ptls_build/libpicotls.a" 2>/dev/null | grep -q 'ELF'; then
      return 0
    fi
    if [[ "$(uname -s)" != "Linux" ]]; then
      return 0
    fi
  fi
  rm -rf "$ptls_build"
  "$CMAKE_BIN" -S "$DEPS_DIR/picotls" -B "$ptls_build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DOPENSSL_ROOT_DIR="${OPENSSL_ROOT_DIR:-}"
  "$CMAKE_BIN" --build "$ptls_build" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" \
    --target picotls-core picotls-minicrypto picotls-openssl
}

build_moq5() {
  clone_dep picoquic "$PICOQUIC_REPO"
  clone_dep picotls "$PICOTLS_REPO"
  build_picotls

  local build_dir="$MOQ5_DIR/build-wt"
  "$CMAKE_BIN" -S "$MOQ5_DIR" -B "$build_dir" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_PREFIX" \
    -DMOQ_BUILD_SERVICE=ON \
    -DMOQ_BUILD_MSF=ON \
    -DMOQ_BUILD_MEDIA_OBJECT=ON \
    -DMOQ_BUILD_ADAPTER_PICOQUIC=ON \
    -DMOQ_BUILD_ADAPTER_PICO_WT=ON \
    -DMOQ_BUILD_PICO_WT_MANAGED=ON \
    -DMOQ_PICOQUIC_SOURCE_DIR="$DEPS_DIR/picoquic" \
    -DMOQ_PICOTLS_PREFIX="$DEPS_DIR/picotls/build"

  "$CMAKE_BIN" --build "$build_dir" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  "$CMAKE_BIN" --install "$build_dir"
}

build_publisher() {
  local pub_build="$ROOT_DIR/tools/moq5-publisher/build"
  rm -rf "$pub_build"
  "$CMAKE_BIN" -S "$ROOT_DIR/tools/moq5-publisher" -B "$pub_build" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_PREFIX_PATH="$INSTALL_PREFIX" \
    -DMOQ5_PREFIX="$INSTALL_PREFIX" \
    -DMOQ_PICOQUIC_SOURCE_DIR="$DEPS_DIR/picoquic" \
    -DMOQ_PICOTLS_PREFIX="$DEPS_DIR/picotls/build"
  "$CMAKE_BIN" --build "$pub_build" -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
  install -d "$(dirname "$PUBLISHER_BIN")"
  install -m 0755 "$pub_build/moq5-fmp4-publish" "$PUBLISHER_BIN"
}

main() {
  if [[ -x "$PUBLISHER_BIN" ]] && file "$PUBLISHER_BIN" | grep -qE 'ELF|Mach-O'; then
    if [[ "$(uname -s)" == "Linux" ]]; then
      file "$PUBLISHER_BIN" | grep -q 'ELF' || rm -f "$PUBLISHER_BIN"
    fi
  fi
  if [[ -x "$PUBLISHER_BIN" ]]; then
    echo "moq5-fmp4-publish already installed at $PUBLISHER_BIN"
    exit 0
  fi

  rm -rf "$INSTALL_PREFIX" "$MOQ5_DIR/build-wt"

  ensure_prerequisites
  ensure_moq5
  build_moq5
  build_publisher
  echo "Installed moq5-fmp4-publish to $PUBLISHER_BIN"
  echo "dev.sh prepends tools/moq5-publisher/bin to PATH automatically."
}

main "$@"
