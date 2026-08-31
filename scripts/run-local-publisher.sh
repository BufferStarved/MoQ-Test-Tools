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

if [[ -x "/opt/homebrew/bin/srt-live-transmit" ]]; then
  export PATH="/opt/homebrew/bin:$PATH"
elif [[ -x "/usr/local/bin/srt-live-transmit" ]]; then
  export PATH="/usr/local/bin:$PATH"
fi
if [[ -x "$ROOT_DIR/tools/moq5-publisher/bin/moq5-fmp4-publish" ]]; then
  export PATH="$ROOT_DIR/tools/moq5-publisher/bin:$PATH"
fi
if [[ -x "$ROOT_DIR/tools/openmoq-publisher/bin/openmoq-publisher" ]]; then
  export PATH="$ROOT_DIR/tools/openmoq-publisher/bin:$PATH"
fi

export PYTHONPATH="$ROOT_DIR/src:$ROOT_DIR:$ROOT_DIR/web/api${PYTHONPATH:+:$PYTHONPATH}"

# Caller exports win over repo .env so a public-site paste cannot be rewritten
# to localhost (or lose LOCAL_PUBLISHER_SESSION) by a leftover dev file.
_CALLER_API="${LOCAL_PUBLISHER_API:-}"
_CALLER_SESSION="${LOCAL_PUBLISHER_SESSION:-}"
_CALLER_TOKEN="${LOCAL_PUBLISHER_TOKEN:-}"
_CALLER_INSECURE="${MOQ_PUBLISHER_INSECURE:-}"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

[[ -n "$_CALLER_API" ]] && export LOCAL_PUBLISHER_API="$_CALLER_API"
[[ -n "$_CALLER_SESSION" ]] && export LOCAL_PUBLISHER_SESSION="$_CALLER_SESSION"
[[ -n "$_CALLER_TOKEN" ]] && export LOCAL_PUBLISHER_TOKEN="$_CALLER_TOKEN"
[[ -n "$_CALLER_INSECURE" ]] && export MOQ_PUBLISHER_INSECURE="$_CALLER_INSECURE"
export LOCAL_PUBLISHER_API="${LOCAL_PUBLISHER_API:-http://127.0.0.1:8000}"
export LOCAL_PUBLISHER_TOKEN="${LOCAL_PUBLISHER_TOKEN:-dev-local-publisher}"
# sslip.io :14433 needs skip-verify. Leftover .env must not drop it; the
# one-liner (MOQ_PUBLISHER_INSECURE=1) still wins via _CALLER_INSECURE.
export MOQ_PUBLISHER_INSECURE="${MOQ_PUBLISHER_INSECURE:-1}"
MOQ_HELPER_GIT_SHA="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || true)"
export MOQ_HELPER_GIT_SHA
if [[ -n "$MOQ_HELPER_GIT_SHA" ]]; then
  echo "Laptop helper SHA $MOQ_HELPER_GIT_SHA (restart this after git pull; SPA refresh is not enough)."
fi

# Must succeed: installs/upgrades a WHIP-capable ffmpeg and writes FFMPEG.
if ! bash "$ROOT_DIR/scripts/ensure-publisher-tools.sh"; then
  echo "Publisher tools are not ready. The agent will not start." >&2
  exit 1
fi
if [[ -f "$ROOT_DIR/.publisher-tools.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.publisher-tools.env"
fi

# Refuse public orchestrator URLs even if .env or the caller set them.
python - "$LOCAL_PUBLISHER_API" <<'PY'
import sys
from publisher_agent.api_guard import assert_publisher_api_allowed

assert_publisher_api_allowed(sys.argv[1])
PY

# exec so Ctrl+C / reset kill this PID, not a bash parent that orphans the agent.
exec python -m publisher_agent "$@"
