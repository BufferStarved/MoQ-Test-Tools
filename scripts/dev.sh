#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ -d ".venv" ]; then
  source .venv/bin/activate
elif [ -d "venv" ]; then
  source venv/bin/activate
else
  python3 -m venv .venv
  source .venv/bin/activate
fi

pip install -q -r requirements.txt

# Prefer ffmpeg-full (SRT + libvmaf) and srt-live-transmit for network metrics.
if [ -x "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" ]; then
  export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"
  export FFMPEG="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
fi
if [ -x "/opt/homebrew/bin/srt-live-transmit" ]; then
  export PATH="/opt/homebrew/bin:$PATH"
fi
if [ -x "$ROOT_DIR/tools/openmoq-publisher/bin/openmoq-publisher" ]; then
  export PATH="$ROOT_DIR/tools/openmoq-publisher/bin:$PATH"
fi
if [ -x "$ROOT_DIR/tools/moq5-publisher/bin/moq5-fmp4-publish" ]; then
  export PATH="$ROOT_DIR/tools/moq5-publisher/bin:$PATH"
elif [ -x "$ROOT_DIR/tools/openmoq-publisher/bin/openmoq-publisher" ]; then
  export PATH="$ROOT_DIR/tools/openmoq-publisher/bin:$PATH"
fi

export PYTHONPATH="$ROOT_DIR/src:$ROOT_DIR/web/api"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

# Local publisher agent (laptop ffmpeg) — enabled for dev only.
# Hosted/prod must NOT set LOCAL_PUBLISHER_ENABLED (cloud VM keeps encoding).
export LOCAL_PUBLISHER_ENABLED="${LOCAL_PUBLISHER_ENABLED:-1}"
export LOCAL_PUBLISHER_TOKEN="${LOCAL_PUBLISHER_TOKEN:-dev-local-publisher}"

uvicorn main:app --reload --host 127.0.0.1 --port 8000 --app-dir web/api &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "API running at http://127.0.0.1:8000"
echo "Local publisher: ENABLED (token=$LOCAL_PUBLISHER_TOKEN)"
echo "  In another terminal: ./scripts/run-local-publisher.sh"
echo "Starting frontend at http://127.0.0.1:5173"
echo ""

if [[ ! -x "$ROOT_DIR/web/frontend/node_modules/.bin/vite" ]]; then
  echo "Installing frontend dependencies (vite missing)..."
  npm install --prefix "$ROOT_DIR/web/frontend"
fi

npm run dev --prefix web/frontend
