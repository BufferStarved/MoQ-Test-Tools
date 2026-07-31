#!/usr/bin/env bash
# Start the local publisher agent against a local (or later remote) orchestrator API.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Fresh clones have no venv and macOS has no bare `python` — bootstrap one.
if [[ -d ".venv" ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
elif [[ -d "venv" ]]; then
  # shellcheck disable=SC1091
  source venv/bin/activate
else
  echo "Creating Python environment (.venv)…"
  python3 -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

# Agent dependencies (websockets, psutil, …); no-op when already installed.
python -m pip install -q -r requirements.txt

# Match scripts/dev.sh tool discovery so ffmpeg/srt/moq are on PATH.
if [[ -x "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg" ]]; then
  export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"
  export FFMPEG="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
fi
if [[ -x "/opt/homebrew/bin/srt-live-transmit" ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
elif [[ -x "/usr/local/bin/srt-live-transmit" ]]; then
  export PATH="/usr/local/bin:$PATH"
fi
if [[ -x "$ROOT_DIR/tools/openmoq-publisher/bin/openmoq-publisher" ]]; then
  export PATH="$ROOT_DIR/tools/openmoq-publisher/bin:$PATH"
fi

export PYTHONPATH="$ROOT_DIR/src:$ROOT_DIR:$ROOT_DIR/web/api${PYTHONPATH:+:$PYTHONPATH}"
export LOCAL_PUBLISHER_API="${LOCAL_PUBLISHER_API:-http://127.0.0.1:8000}"
export LOCAL_PUBLISHER_TOKEN="${LOCAL_PUBLISHER_TOKEN:-dev-local-publisher}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

# Ensure optional tools when missing (macOS Homebrew + repo installer).
bash "$ROOT_DIR/scripts/ensure-publisher-tools.sh" || true

python -m publisher_agent "$@"
