#!/usr/bin/env bash
# Watch MediaMTX for live paths and package CMAF LL-DASH via ffmpeg.
#
# MediaMTX does not speak DASH; this sidecar pulls RTSP and writes an
# ldash MPD + fragments under DASH_ROOT/<path>/ for nginx (port 8891).
#
# Env:
#   MTX_API=http://127.0.0.1:9997
#   DASH_ROOT=/opt/moq-mediamtx/dash
#   FFMPEG=ffmpeg
#   PATHS=benchmark          # space-separated; empty = any ready path
#   POLL_SEC=2
set -euo pipefail

MTX_API="${MTX_API:-http://127.0.0.1:9997}"
DASH_ROOT="${DASH_ROOT:-/opt/moq-mediamtx/dash}"
FFMPEG="${FFMPEG:-ffmpeg}"
PATHS="${PATHS:-benchmark}"
POLL_SEC="${POLL_SEC:-2}"
STATE_DIR="${STATE_DIR:-/run/moq-mediamtx-lldash}"

mkdir -p "$DASH_ROOT" "$STATE_DIR"

log() { echo "[lldash] $*"; }

list_ready_paths() {
  # MediaMTX v3 API: {"items":[{"name":"benchmark","ready":true,...}]}
  curl -fsS "${MTX_API}/v3/paths/list" 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
items = data.get("items") or data.get("paths") or []
if isinstance(items, dict):
    items = [{"name": k, **(v if isinstance(v, dict) else {})} for k, v in items.items()]
for item in items:
    if not isinstance(item, dict):
        continue
    name = item.get("name") or item.get("path") or ""
    if name and item.get("ready") is True:
        print(name)
' || true
}

is_path_ready() {
  local path="$1"
  curl -fsS "${MTX_API}/v3/paths/get/${path}" 2>/dev/null | python3 -c '
import json,sys
try:
  d=json.load(sys.stdin)
except Exception:
  sys.exit(1)
sys.exit(0 if d.get("ready") else 1)
' 2>/dev/null
}

start_packager() {
  local path="$1"
  local pidfile="${STATE_DIR}/${path}.pid"
  local outdir="${DASH_ROOT}/${path}"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0
  fi
  mkdir -p "$outdir"
  # Clear stale fragments so dash.js does not stick to an old timeline.
  rm -f "$outdir"/* 2>/dev/null || true
  log "starting LL-DASH packager for path=${path}"
  # Pull remuxed H.264/AAC from MediaMTX RTSP; package CMAF low-latency DASH.
  nohup "$FFMPEG" -hide_banner -loglevel warning \
    -rtsp_transport tcp \
    -i "rtsp://127.0.0.1:8554/${path}" \
    -map 0:v:0 -map 0:a:0? \
    -c:v copy -c:a aac -b:a 128k -ac 2 -ar 48000 \
    -f dash \
    -ldash 1 \
    -streaming 1 \
    -remove_at_exit 1 \
    -window_size 5 \
    -extra_window_size 5 \
    -seg_duration 1 \
    -frag_type duration \
    -frag_duration 0.2 \
    -use_template 1 \
    -use_timeline 1 \
    -adaptation_sets "id=0,streams=v id=1,streams=a" \
    "${outdir}/manifest.mpd" \
    >>"${STATE_DIR}/${path}.log" 2>&1 &
  echo $! >"$pidfile"
}

stop_packager() {
  local path="$1"
  local pidfile="${STATE_DIR}/${path}.pid"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      log "stopping LL-DASH packager for path=${path} (pid=${pid})"
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

cleanup() {
  if [[ -n "${PATHS}" ]]; then
    for path in $PATHS; do
      stop_packager "$path"
    done
  fi
  exit 0
}
trap cleanup INT TERM

log "watching MediaMTX API ${MTX_API} → ${DASH_ROOT}"
while true; do
  if [[ -n "${PATHS}" ]]; then
    watch_list="$PATHS"
  else
    watch_list="$(list_ready_paths | tr '\n' ' ')"
  fi
  for path in $watch_list; do
    [[ -z "$path" ]] && continue
    if is_path_ready "$path"; then
      start_packager "$path"
      # Restart if ffmpeg died while path is still ready.
      pidfile="${STATE_DIR}/${path}.pid"
      if [[ -f "$pidfile" ]] && ! kill -0 "$(cat "$pidfile")" 2>/dev/null; then
        rm -f "$pidfile"
        start_packager "$path"
      fi
    else
      stop_packager "$path"
    fi
  done
  sleep "$POLL_SEC"
done
