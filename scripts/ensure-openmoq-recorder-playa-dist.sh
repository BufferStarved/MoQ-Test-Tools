#!/usr/bin/env bash
# Materialize gitignored playa package dist/ trees the recorder Dockerfile COPYs.
# A git checkout only has source; docker build then fails with:
#   "/web/frontend/vendor/moq-playa/packages/webtransport/dist": not found
# Published @moqt/{msf,transport,webtransport} tarballs already contain dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/web/frontend/vendor/moq-playa/packages"
VERSION="${MOQ_PLAYA_NPM_VERSION:-}"
PACKAGES=(msf transport webtransport)

if [[ -z "$VERSION" ]]; then
  for pkg in "${PACKAGES[@]}"; do
    if [[ -f "$VENDOR/$pkg/package.json" ]]; then
      VERSION="$(python3 -c "import json; print(json.load(open('$VENDOR/$pkg/package.json'))['version'])")"
      break
    fi
  done
fi
VERSION="${VERSION:-0.5.7}"

need=0
for pkg in "${PACKAGES[@]}"; do
  if [[ ! -f "$VENDOR/$pkg/dist/index.js" ]]; then
    need=1
    break
  fi
done
if [[ "$need" -eq 0 ]]; then
  echo "Recorder playa dist/ already present (msf/transport/webtransport @${VERSION})"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to fetch @moqt/*@${VERSION} dist/" >&2
  exit 1
fi

echo "Filling missing recorder playa dist/ from npm @moqt/*@${VERSION}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for pkg in "${PACKAGES[@]}"; do
  dest="$VENDOR/$pkg"
  if [[ -f "$dest/dist/index.js" ]]; then
    echo "  @moqt/${pkg}: dist/ already present"
    continue
  fi
  tarball="$tmp/${pkg}.tgz"
  url="https://registry.npmjs.org/@moqt/${pkg}/-/${pkg}-${VERSION}.tgz"
  echo "  fetching ${url}"
  curl -fsSL "$url" -o "$tarball"
  mkdir -p "$tmp/extract/$pkg"
  tar -xzf "$tarball" -C "$tmp/extract/$pkg"
  if [[ ! -f "$tmp/extract/$pkg/package/dist/index.js" ]]; then
    echo "npm tarball @moqt/${pkg}@${VERSION} has no package/dist/index.js" >&2
    exit 1
  fi
  mkdir -p "$dest/dist"
  cp -a "$tmp/extract/$pkg/package/dist/." "$dest/dist/"
  if [[ ! -f "$dest/package.json" ]]; then
    cp "$tmp/extract/$pkg/package/package.json" "$dest/package.json"
  fi
  echo "  @moqt/${pkg}: wrote $dest/dist"
done
