#!/usr/bin/env bash
# Targeted app-only deploy to the web VM.
#
# infra/web/scripts/install-web-app.sh is the full provisioner: it runs
# apt-get, rewrites /etc/moq-web.env and the Caddyfile, and rebuilds moq5.
# All of that is correct for a fresh VM and all of it is unnecessary risk when
# the only thing that changed is application code. This script syncs the app
# tree, rebuilds the SPA, and restarts the unit — strictly less mutating.
#
# Usage:
#   scripts/deploy-web-targeted.sh [web-ip]
#
# This is the prod deploy. It exports `git archive HEAD` and syncs that, so
# uncommitted OBS / moq5 / infra work on the laptop never reaches
# moq.sean-mccarthy.net. The SHA is the short commit with no suffix.
#
# Env:
#   WEB_IP        default 34.9.217.178 (moq-web-gcp, reached via the IAP
#                 ProxyCommand in ~/.ssh/config)
#   SKIP_BUILD=1  sync + restart only, no npm build
#   SKIP_RESTART=1 sync (+build) only, leave the service alone
#   MOQ_ENV       must be prod (default). Dev is local: scripts/dev.sh.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_IP="${1:-${WEB_IP:-34.9.217.178}}"
INSTALL_ROOT="/opt/moq-test-tools"
SERVICE_NAME="moq-web"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=30)
remote() { ssh "${SSH_OPTS[@]}" "$WEB_IP" "$@"; }

echo "==> target $WEB_IP"
remote 'hostname; systemctl is-active moq-web || true'

# Refuse to restart out from under a live job. A restart mid-run does not just
# lose the run: the browser keeps POSTing playback samples against a job id the
# new process has never heard of, so the CSV ends up with an encoder half and
# no player half and looks like a player bug.
if [[ "${SKIP_RESTART:-0}" != "1" ]]; then
  echo "==> checking for in-flight jobs"
  ACTIVE="$(curl -fsS -m 20 "https://moq.sean-mccarthy.net/api/uploads" 2>/dev/null \
    | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(0); raise SystemExit
items=d if isinstance(d,list) else d.get("jobs",d.get("uploads",[]))
print(sum(1 for j in items if isinstance(j,dict) and j.get("status") in ("running","starting","pending")))' 2>/dev/null || echo 0)"
  # pipefail + a down site yields "0\n0"; first line only so a 502 is idle, not a refuse.
  ACTIVE="$(printf '%s' "${ACTIVE:-0}" | head -n1 | tr -cd '0-9')"
  ACTIVE="${ACTIVE:-0}"
  if [[ "$ACTIVE" != "0" ]]; then
    echo "REFUSING: $ACTIVE job(s) in flight. Re-run when idle or set SKIP_RESTART=1." >&2
    exit 3
  fi
  echo "    idle"
fi

# One prod build: committed HEAD only. A dirty working tree is the other
# environment (dev) and is never what this script ships.
export MOQ_ENV="${MOQ_ENV:-prod}"
if [[ "$MOQ_ENV" != "prod" ]]; then
  echo "REFUSING: deploy-web-targeted.sh is the prod deploy. Dev is local (scripts/dev.sh)." >&2
  exit 2
fi
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/build-identity.sh"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/moq-prod-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
git -C "$ROOT_DIR" archive HEAD | tar -x -C "$STAGE"
printf '%s\n' "$GIT_SHA" > "$STAGE/.build-sha"
echo "==> prod sha $GIT_SHA (git archive HEAD, not the working tree)"

# git archive omits gitignored vendor package dist/. Vite resolves
# @playa/player to ./dist/index.js, so a playa upgrade that ships source
# only leaves the previous build on the VM. Copy the local install-playa.sh
# artifacts that match this vendor source.
vendor_dists=()
while IFS= read -r d; do
  vendor_dists+=("$d")
done < <(cd "$ROOT_DIR" && find web/frontend/vendor/moq-playa/packages -mindepth 2 -maxdepth 2 -type d -name dist)
if [[ ${#vendor_dists[@]} -eq 0 ]]; then
  echo "REFUSING: no vendor package dist/ next to HEAD. Run FORCE=1 ./scripts/install-playa.sh first." >&2
  exit 4
fi
for d in "${vendor_dists[@]}"; do
  mkdir -p "$STAGE/$d"
  rsync -a "$ROOT_DIR/$d/" "$STAGE/$d/"
done
echo "==> staged ${#vendor_dists[@]} vendor package dist/ trees"

echo "==> rsync app tree"
rsync -az \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.venv' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/src/" "$WEB_IP:$INSTALL_ROOT/src/"

rsync -az --exclude '__pycache__' --exclude '*.pyc' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/web/api/" "$WEB_IP:$INSTALL_ROOT/web/api/"

rsync -az --exclude '__pycache__' --exclude '*.pyc' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/tests/" "$WEB_IP:$INSTALL_ROOT/tests/"

rsync -az --exclude '__pycache__' --exclude '*.pyc' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/scripts/" "$WEB_IP:$INSTALL_ROOT/scripts/"

rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/docs/" "$WEB_IP:$INSTALL_ROOT/docs/"

# Frontend sources only. node_modules and dist stay remote: node_modules is
# huge and already correct, dist is rebuilt on the VM below.
rsync -az \
  --exclude 'node_modules' \
  --exclude 'dist' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/web/frontend/" "$WEB_IP:$INSTALL_ROOT/web/frontend/"

# Frontend rsync excludes every dist/. Push vendor package builds separately
# so prod @playa/player matches the headed 0.5.7 check, not leftover 0.5.3.
for d in "${vendor_dists[@]}"; do
  rsync -az -e "ssh ${SSH_OPTS[*]}" \
    "$STAGE/$d/" "$WEB_IP:$INSTALL_ROOT/$d/"
done

# Recorder JS is bind-mounted into openmoq-recorder:latest. Missing
# record-policy.mjs makes Linode :14433 ingest record 0 bytes after §11.1.
# The docker wrapper must mount it too — recording_service falls back to
# that script when `docker` is not on the agent PATH, and the baked image
# never COPY'd the file.
remote "mkdir -p $INSTALL_ROOT/tools/openmoq-recorder/bin $INSTALL_ROOT/tools/moq5-publisher $INSTALL_ROOT/ingest_agent"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/tools/openmoq-recorder/record.mjs" \
  "$STAGE/tools/openmoq-recorder/record-policy.mjs" \
  "$STAGE/tools/openmoq-recorder/cert.mjs" \
  "$STAGE/tools/openmoq-recorder/openmoq-init.mjs" \
  "$STAGE/tools/openmoq-recorder/wt-adapter.mjs" \
  "$WEB_IP:$INSTALL_ROOT/tools/openmoq-recorder/"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/tools/openmoq-recorder/bin/openmoq-fmp4-record-docker" \
  "$WEB_IP:$INSTALL_ROOT/tools/openmoq-recorder/bin/"

rsync -az --exclude '__pycache__' --exclude '*.pyc' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/ingest_agent/" "$WEB_IP:$INSTALL_ROOT/ingest_agent/"

# Publisher C (CONNECT-before-moov). Binary is rebuilt on the VM below
# only when the tree is already cmake-configured.
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/tools/moq5-publisher/fmp4_moq_bridge.c" \
  "$STAGE/tools/moq5-publisher/fmp4_moq_bridge.h" \
  "$STAGE/tools/moq5-publisher/fmp4_moq_bridge_priv.h" \
  "$STAGE/tools/moq5-publisher/main.c" \
  "$STAGE/tools/moq5-publisher/CMakeLists.txt" \
  "$WEB_IP:$INSTALL_ROOT/tools/moq5-publisher/"

rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$STAGE/.build-sha" "$WEB_IP:$INSTALL_ROOT/.build-sha"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> npm build (SPA)"
  remote "cd $INSTALL_ROOT/web/frontend && VITE_GIT_SHA=$GIT_SHA npm run build 2>&1 | tail -15"
fi

if [[ "${SKIP_RESTART:-0}" != "1" ]]; then
  echo "==> stamp MOQ_ENV=prod on the unit"
  remote 'sudo bash -s' <<'ENV'
set -euo pipefail
ENV_FILE=/etc/moq-web.env
if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^MOQ_ENV=' "$ENV_FILE"; then
    sed -i 's/^MOQ_ENV=.*/MOQ_ENV=prod/' "$ENV_FILE"
  else
    printf '\nMOQ_ENV=prod\n' >> "$ENV_FILE"
  fi
fi
ENV
  echo "==> restart $SERVICE_NAME"
  remote "sudo systemctl restart $SERVICE_NAME && sleep 4 && systemctl is-active $SERVICE_NAME"
  echo "==> rebuild moq5-fmp4-publish if a build tree exists"
  remote "if [[ -f $INSTALL_ROOT/tools/moq5-publisher/build/Makefile ]]; then
    cmake --build $INSTALL_ROOT/tools/moq5-publisher/build --target moq5-fmp4-publish -j2
    install -m 0755 $INSTALL_ROOT/tools/moq5-publisher/build/moq5-fmp4-publish \
      $INSTALL_ROOT/tools/moq5-publisher/bin/moq5-fmp4-publish
  else
    echo '    skip (no cmake build tree)'
  fi"
  if remote "systemctl is-active --quiet moq-ingest-agent.service"; then
    echo "==> restart moq-ingest-agent (recorder bind-mount)"
    remote "sudo systemctl restart moq-ingest-agent.service && sleep 2 && systemctl is-active moq-ingest-agent.service"
  else
    echo "==> moq-ingest-agent not active (recorder may live in-process on moq-web)"
  fi
fi

echo "==> health"
curl -fsS -m 20 "https://moq.sean-mccarthy.net/api/health"; echo
echo "==> done ($GIT_SHA)"
