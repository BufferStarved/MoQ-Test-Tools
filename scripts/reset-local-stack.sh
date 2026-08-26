#!/usr/bin/env bash
# Kill leftover local API / Vite / publisher-agent so the next ./scripts/dev.sh
# is one process tree and one agent. Ghost helpers (PPID 1) were sending
# webcam jobs to stale Python that still had the old ffmpeg argv.
set -euo pipefail

API_URL="${LOCAL_PUBLISHER_API:-http://127.0.0.1:8000}"

usage() {
  cat <<'EOF'
Usage: ./scripts/reset-local-stack.sh [--status]

  (default)  Kill listeners on :8000/:5173/:5174 and every publisher_agent.
  --status   Print ports + /api/features agent ids (no kill).
EOF
}

kill_pids() {
  local pids="$1"
  [[ -n "$pids" ]] || return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}

kill_pids_hard() {
  local pids="$1"
  [[ -n "$pids" ]] || return 0
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null || true
}

listen_pids() {
  local port="$1"
  lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

# Do not start this pattern with `-m`: macOS pgrep treats that as a switch
# and returns nothing, so reset left orphan helpers (PPID 1) after Ctrl+C.
AGENT_PATTERN='[Pp]ython -m publisher_agent'

pattern_pids() {
  local pat="$1"
  pgrep -f "$pat" 2>/dev/null || true
}

agent_pids() {
  pattern_pids "$AGENT_PATTERN"
}

print_status() {
  echo "ports:"
  for port in 8000 5173 5174; do
    local pids
    pids="$(listen_pids "$port")"
    if [[ -n "$pids" ]]; then
      echo "  :$port  $(echo "$pids" | tr '\n' ' ')"
    else
      echo "  :$port  (free)"
    fi
  done
  echo "publisher_agent: $(agent_pids | tr '\n' ' ' || true)"
  if curl -sf --max-time 2 "$API_URL/api/health" >/dev/null 2>&1; then
    curl -s --max-time 2 "$API_URL/api/features" | python3 -c '
import json, sys
d = json.load(sys.stdin)
ids = [a.get("agent_id") for a in (d.get("local_publisher_agents") or [])]
print("agents:", ids or "(none)")
'
  else
    echo "agents: (API down)"
  fi
}

wait_ports_free() {
  local port="$1"
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [[ -z "$(listen_pids "$port")" ]] && return 0
    sleep 0.2
  done
  return 1
}

wait_agents_gone() {
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [[ -z "$(agent_pids)" ]] && return 0
    sleep 0.15
  done
  return 1
}

reset_stack() {
  local pids port
  # Agent first. Killing :8000 first makes a live helper log "retry in Ns"
  # on the dev.sh TTY after the shell prompt is back.
  kill_pids "$(agent_pids)"
  kill_pids "$(pattern_pids 'scripts/run-local-publisher.sh')"
  if ! wait_agents_gone; then
    kill_pids_hard "$(agent_pids)"
  fi
  for port in 8000 5173 5174; do
    pids="$(listen_pids "$port")"
    kill_pids "$pids"
  done
  kill_pids "$(pattern_pids 'uvicorn main:app --reload --host 127.0.0.1 --port 8000')"
  sleep 0.3
  for port in 8000 5173 5174; do
    pids="$(listen_pids "$port")"
    kill_pids_hard "$pids"
  done
  kill_pids_hard "$(agent_pids)"
  for port in 8000 5173 5174; do
    if ! wait_ports_free "$port"; then
      echo "reset-local-stack: :$port still listening: $(listen_pids "$port")" >&2
      exit 1
    fi
  done
  if [[ -n "$(agent_pids)" ]]; then
    echo "reset-local-stack: publisher_agent still running: $(agent_pids)" >&2
    exit 1
  fi
  echo "reset-local-stack: :8000 :5173 :5174 free, no publisher_agent"
}

case "${1:-}" in
  -h|--help) usage ;;
  --status) print_status ;;
  "") reset_stack ;;
  *) usage >&2; exit 2 ;;
esac
