#!/usr/bin/env bash
# Fast local gate: Python regressions + frontend unit scripts.
# Does not hit live ingest. East live matrix:
#   STACK=east DURATION=18 python3 scripts/e2e_ingest_matrix_test.py
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -x "$ROOT/.venv/bin/python3" ]]; then
  PYTHON="$ROOT/.venv/bin/python3"
elif [[ -x "$ROOT/venv/bin/python3" ]]; then
  PYTHON="$ROOT/venv/bin/python3"
else
  PYTHON="python3"
fi
export PYTHONPATH="$ROOT/src:$ROOT/web/api${PYTHONPATH:+:$PYTHONPATH}"

"$PYTHON" -m unittest \
  tests.test_east_ffmpeg_regressions \
  tests.test_browser_moq_api_gates \
  tests.test_mediamtx_loopback_and_whip_audio \
  tests.test_mediamtx_stats \
  tests.test_job_manager_preview_gate \
  tests.test_cloud_placement \
  tests.test_encoder_metrics_fixes \
  -q

for script in "$ROOT"/web/frontend/scripts/unit-*.mjs; do
  node "$script"
done
