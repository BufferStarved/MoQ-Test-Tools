#!/usr/bin/env bash
# Install @playa/player for the benchmark web UI (vendored moq-playa monorepo).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/web/frontend"
VENDOR_DIR="$FRONTEND_DIR/vendor/moq-playa"
PLAYA_REPO="${MOQ_PLAYA_REPO:-https://github.com/openmoq/moq-playa.git}"
PLAYA_REF="${MOQ_PLAYA_REF:-main}"
# The vendor dir is a plain snapshot (no .git), so re-running this script
# normally never picks up upstream fixes. Set FORCE=1 to re-clone/rebuild
# even when a stale dist/ already exists.
FORCE="${FORCE:-0}"

# Upstream now nests packages under packages/*. Keep that layout intact
# (its per-package tsconfig "extends"/"references" paths assume it) rather
# than flattening, and point our package.json at packages/playa directly.
PLAYA_PKG_DIR="$VENDOR_DIR/packages/playa"

if [[ "$FORCE" == "1" || ! -d "$PLAYA_PKG_DIR/dist" ]]; then
  echo "Cloning playa monorepo (ref=$PLAYA_REF) into $VENDOR_DIR"
  rm -rf "$VENDOR_DIR"
  mkdir -p "$(dirname "$VENDOR_DIR")"
  git clone --depth 1 --branch "$PLAYA_REF" "$PLAYA_REPO" "$VENDOR_DIR"
  rm -rf "$VENDOR_DIR/.git"
fi

if [[ ! -f "$PLAYA_PKG_DIR/dist/index.js" ]]; then
  echo "Building @playa/player (pnpm workspace: build all packages)..."
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "error: pnpm is required to build the vendored moq-playa monorepo (workspace:* deps)." >&2
    exit 1
  fi
  (
    cd "$VENDOR_DIR"
    pnpm install --no-frozen-lockfile
    pnpm -r build
  )
fi

# Each package's dist/ is a fully bundled artifact (tsup inlines sibling
# @moqt/* packages), so npm never needs to actually install them at runtime.
# But plain npm chokes just parsing "workspace:*" specifiers when it reads
# these package.json files through file: links (npm following playa's own
# sibling deps recursively), so rewrite them to file: sibling paths (which
# npm understands) purely to make `npm install` succeed.
echo "Rewriting workspace:* deps under packages/*/package.json for plain npm..."
python3 - "$VENDOR_DIR/packages" <<'EOF'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
for pkg_json in root.glob("*/package.json"):
    with open(pkg_json) as fh:
        data = json.load(fh)
    changed = False
    for field in ("dependencies", "devDependencies", "peerDependencies"):
        deps = data.get(field, {})
        for name in list(deps):
            if deps[name] == "workspace:*":
                short = name.split("/", 1)[1]
                deps[name] = f"file:../{short}"
                changed = True
    if changed:
        with open(pkg_json, "w") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
EOF

echo "Installing frontend dependencies (links @playa/player from vendor)..."
if ! grep -q "vendor/moq-playa/packages/playa" "$FRONTEND_DIR/package.json"; then
  echo "Updating @playa/player dependency path to packages/playa layout..."
  sed -i.bak 's#file:vendor/moq-playa/playa#file:vendor/moq-playa/packages/playa#' "$FRONTEND_DIR/package.json"
  rm -f "$FRONTEND_DIR/package.json.bak"
  rm -f "$FRONTEND_DIR/package-lock.json"
fi
npm install --prefix "$FRONTEND_DIR"

echo "Playa ready: $PLAYA_PKG_DIR"
echo "MoQ playback uses @playa/player in Chrome/Edge (WebTransport)."
