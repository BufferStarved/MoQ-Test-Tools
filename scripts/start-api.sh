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

export PYTHONPATH="$ROOT_DIR/src:$ROOT_DIR/web/api"

# Load .env (preset credentials, ingest agent config) plus East/Linode stacks.
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-dev-env.sh"

uvicorn main:app --reload --host 127.0.0.1 --port 8000 --app-dir web/api
