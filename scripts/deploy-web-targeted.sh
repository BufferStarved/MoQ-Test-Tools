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
# Env:
#   WEB_IP        default 34.9.217.178 (moq-web-gcp, reached via the IAP
#                 ProxyCommand in ~/.ssh/config)
#   SKIP_BUILD=1  sync + restart only, no npm build
#   SKIP_RESTART=1 sync (+build) only, leave the service alone

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
  if [[ "${ACTIVE:-0}" != "0" ]]; then
    echo "REFUSING: $ACTIVE job(s) in flight. Re-run when idle or set SKIP_RESTART=1." >&2
    exit 3
  fi
  echo "    idle"
fi

# Build sha marker: rsync deploys the working tree, not a commit, so a clean
# HEAD sha would make a dirty deploy indistinguishable from the last tagged one.
GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=normal 2>/dev/null || true)" ]]; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
printf '%s\n' "$GIT_SHA" > "$ROOT_DIR/.build-sha"
echo "==> build sha $GIT_SHA"

echo "==> rsync app tree"
rsync -az \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.venv' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/src/" "$WEB_IP:$INSTALL_ROOT/src/"

rsync -az --exclude '__pycache__' --exclude '*.pyc' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/web/api/" "$WEB_IP:$INSTALL_ROOT/web/api/"

rsync -az --exclude '__pycache__' --exclude '*.pyc' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/tests/" "$WEB_IP:$INSTALL_ROOT/tests/"

rsync -az --exclude '__pycache__' --exclude '*.pyc' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/scripts/" "$WEB_IP:$INSTALL_ROOT/scripts/"

rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/docs/" "$WEB_IP:$INSTALL_ROOT/docs/"

# Frontend sources only. node_modules and dist stay remote: node_modules is
# huge and already correct, dist is rebuilt on the VM below.
rsync -az \
  --exclude 'node_modules' \
  --exclude 'dist' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/web/frontend/" "$WEB_IP:$INSTALL_ROOT/web/frontend/"

rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT_DIR/.build-sha" "$WEB_IP:$INSTALL_ROOT/.build-sha"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "==> npm build (SPA)"
  remote "cd $INSTALL_ROOT/web/frontend && npm run build 2>&1 | tail -15"
fi

if [[ "${SKIP_RESTART:-0}" != "1" ]]; then
  echo "==> restart $SERVICE_NAME"
  remote "sudo systemctl restart $SERVICE_NAME && sleep 4 && systemctl is-active $SERVICE_NAME"
fi

echo "==> health"
curl -fsS -m 20 "https://moq.sean-mccarthy.net/api/health"; echo
echo "==> done ($GIT_SHA)"
