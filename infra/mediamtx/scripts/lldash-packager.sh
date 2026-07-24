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
#   FFPROBE=ffprobe
#   PATHS=benchmark          # space-separated; empty = any ready path
#   POLL_SEC=2
set -euo pipefail

MTX_API="${MTX_API:-http://127.0.0.1:9997}"
DASH_ROOT="${DASH_ROOT:-/opt/moq-mediamtx/dash}"
FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
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

# MediaMTX can report ready=true a moment before RTSP has decodable video.
# Starting ffmpeg then yields "dimensions not set" and an empty dash/ dir →
# browser 404s (job 29d1f559, 2026-07-22).
rtsp_video_ready() {
  local path="$1"
  local dims
  dims="$("$FFPROBE" -v error -rtsp_transport tcp -analyzeduration 2M -probesize 2M \
    -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x \
    "rtsp://127.0.0.1:8554/${path}" 2>/dev/null || true)"
  [[ "$dims" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]]
}

rtsp_has_audio() {
  local path="$1"
  "$FFPROBE" -v error -rtsp_transport tcp -analyzeduration 2M -probesize 2M \
    -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 \
    "rtsp://127.0.0.1:8554/${path}" 2>/dev/null | grep -qx audio
}

start_packager() {
  local path="$1"
  local pidfile="${STATE_DIR}/${path}.pid"
  local outdir="${DASH_ROOT}/${path}"
  local logfile="${STATE_DIR}/${path}.log"
  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    return 0
  fi
  if ! rtsp_video_ready "$path"; then
    log "path=${path} ready in API but RTSP video not probeable yet — waiting"
    return 0
  fi
  mkdir -p "$outdir"
  # Clear stale fragments only once we know we can replace them.
  rm -f "$outdir"/* 2>/dev/null || true

  local -a maps=("-map" "0:v:0")
  local -a codecs=("-c:v" "copy")
  local adapt="id=0,streams=v"
  if rtsp_has_audio "$path"; then
    # Copy AAC from MediaMTX — re-encoding webcam-derived audio produced
    # non-monotonic DTS / FPE crashes and empty MPDs under load.
    maps+=("-map" "0:a:0")
    codecs+=("-c:a" "copy")
    adapt="id=0,streams=v id=1,streams=a"
  else
    codecs+=("-an")
  fi

  log "starting LL-DASH packager for path=${path} adapt=${adapt}"
  # Do not use -remove_at_exit: a crash mid-run wiped the MPD and made dash.js
  # see hard 404s even while MediaMTX LL-HLS was fine.
  nohup "$FFMPEG" -hide_banner -loglevel warning \
    -fflags +genpts+discardcorrupt+igndts \
    -use_wallclock_as_timestamps 1 \
    -rtsp_transport tcp \
    -analyzeduration 2M -probesize 2M \
    -i "rtsp://127.0.0.1:8554/${path}" \
    "${maps[@]}" \
    "${codecs[@]}" \
    -f dash \
    -ldash 1 \
    -streaming 1 \
    -remove_at_exit 0 \
    -window_size 5 \
    -extra_window_size 5 \
    -seg_duration 1 \
    -frag_type duration \
    -frag_duration 0.2 \
    -use_template 1 \
    -use_timeline 1 \
    -adaptation_sets "${adapt}" \
    "${outdir}/manifest.mpd" \
    >>"${logfile}" 2>&1 &
  local pid=$!
  echo "$pid" >"$pidfile"

  # Abort quickly if ffmpeg dies before writing an MPD (bad probe race).
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    if ! kill -0 "$pid" 2>/dev/null; then
      log "packager for path=${path} exited before MPD (see ${logfile})"
      rm -f "$pidfile"
      return 0
    fi
    if [[ -s "${outdir}/manifest.mpd" ]]; then
      return 0
    fi
  done
  if [[ ! -s "${outdir}/manifest.mpd" ]]; then
    log "packager for path=${path} still has no MPD after 5s — will retry next poll"
    kill "$pid" 2>/dev/null || true
    rm -f "$pidfile"
  fi
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
