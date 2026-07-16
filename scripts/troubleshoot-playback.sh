#!/usr/bin/env bash
# Layered playback troubleshooting — one report, stop at first failed gate.
# Usage: ./scripts/troubleshoot-playback.sh [latest|summary.json|comparison_id]
#
# Layers (do not skip; do not blame a lower layer until upper gates pass):
#   L1 encode/upload   — ffmpeg finished and sent bytes
#   L2 ingest binding  — data reached the correct Zixi stream / MoQ namespace
#   L3 output quality  — HLS segments decodable / MoQ catalog subscribable
#   L4 browser path    — API proxy + player (only if L1–L3 pass)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
ZIXI_SRT_STREAM="${ZIXI_SRT_STREAM:-SRT Test}"
MOQ_RELAY_ADMIN="${MOQ_RELAY_ADMIN:-http://34.28.164.90:8000}"
API_BASE="${API_BASE:-http://127.0.0.1:8000}"
MEDIA="${MEDIA:-dummy.mp4}"
ARG="${1:-latest}"

say() { printf '\n━━ %s ━━\n' "$*"; }
pass() { printf '  ✅ L%s %s\n' "$1" "$2"; }
fail() { printf '  ❌ L%s %s\n' "$1" "$2"; BLOCKED_LAYER="$1"; BLOCKED_REASON="$2"; }
warn() { printf '  ⚠️  %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }

BLOCKED_LAYER=""
BLOCKED_REASON=""

finish() {
  say "VERDICT"
  if [[ -n "$BLOCKED_LAYER" ]]; then
    printf '  STOP at layer %s: %s\n' "$BLOCKED_LAYER" "$BLOCKED_REASON"
    printf '\n  Do not debug browser players until this layer passes.\n'
    exit 1
  fi
  printf '  All checked layers passed. If browser still fails, debug L4 (DevTools → playback/fetch / MoQ diagnostics).\n'
  exit 0
}

# ── Resolve summary files (macOS bash 3.2 has no mapfile) ─────────
SUMMARIES=()
if [[ "$ARG" == "latest" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && SUMMARIES+=("$line")
  done < <(ls -t results/upload_*.summary.json 2>/dev/null | head -4 || true)
elif [[ -f "$ARG" ]]; then
  SUMMARIES=("$ARG")
else
  while IFS= read -r line; do
    [[ -n "$line" ]] && SUMMARIES+=("$line")
  done < <(ls -t results/upload_*_"${ARG}"*.summary.json 2>/dev/null || true)
fi

SRT_SUMMARY=""
MOQ_SUMMARY=""
for s in "${SUMMARIES[@]}"; do
  [[ -f "$s" ]] || continue
  proto="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('protocol',''))" "$s")"
  if [[ "$proto" == "srt" && -z "$SRT_SUMMARY" ]]; then SRT_SUMMARY="$s"; fi
  if [[ "$proto" == "moq" && -z "$MOQ_SUMMARY" ]]; then MOQ_SUMMARY="$s"; fi
done

say "HOW TO READ THIS"
cat <<'EOF'
  We test fixed layers in order. Each layer has one job.
  When a layer fails, STOP — fixes below that layer are irrelevant.

  L1 encode     Did ffmpeg send data off this machine?
  L2 ingest     Did it land on the right Zixi stream / MoQ namespace?
  L3 output     Is the packaged media usable (HLS decode / MoQ catalog)?
  L4 browser    Proxy + hls.js / @playa/player (only after L1–L3)
EOF

# ── L1: Encode / upload ───────────────────────────────────────────
say "L1 — Encode / upload (local ffmpeg → network)"
L1_OK=0
for label in "SRT:$SRT_SUMMARY" "MoQ:$MOQ_SUMMARY"; do
  name="${label%%:*}"
  file="${label#*:}"
  [[ -n "$file" && -f "$file" ]] || { warn "No recent $name summary.json"; continue; }
  read -r samples bytes endpoint < <(python3 -c "
import json,sys
s=json.load(open(sys.argv[1]))
print(s.get('samples',0), s.get('throughput',{}).get('total_bytes_sent',0), s.get('endpoint',''))
" "$file")
  info "$name: samples=$samples bytes_sent=$bytes"
  info "$name endpoint: $endpoint"
  if [[ "$samples" -ge 10 && "$bytes" -gt 50000 ]]; then
    pass 1 "$name encode sent data for full run"
    L1_OK=1
  else
    fail 1 "$name encode looks short or empty"
  fi
done
[[ "$L1_OK" -eq 1 ]] || finish

# ── L2 HLS: ingest binding (media_sequence must advance) ──────────
say "L2 — HLS ingest binding (does SRT reach stream '${ZIXI_SRT_STREAM}'?)"
HLS_URL="http://${ZIXI_HOST}:7777/playback.m3u8?stream=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${ZIXI_SRT_STREAM}'))")"
info "Manifest: $HLS_URL"

seq_a="$(curl -sf "$HLS_URL" 2>/dev/null | awk -F: '/EXT-X-MEDIA-SEQUENCE/ {print $2}' | tr -d '\r' || true)"
info "media_sequence now: ${seq_a:-<none>}"

if [[ -x "$ROOT_DIR/scripts/verify-zixi-srt-ingest.sh" ]]; then
  L2_PASS=0
  for MODE in access plain; do
    info "SRT push test (streamid mode: ${MODE})..."
    set +e
    VERIFY_OUT="$(ZIXI_SRT_STREAMID_MODE="$MODE" "$ROOT_DIR/scripts/verify-zixi-srt-ingest.sh" 2>&1)"
    VERIFY_CODE=$?
    set -e
    echo "$VERIFY_OUT" | sed 's/^/  /'
    if [[ "$VERIFY_CODE" -eq 0 ]]; then
      pass 2 "Zixi HLS advanced with streamid mode '${MODE}'"
      info "Set export ZIXI_SRT_STREAMID_MODE=${MODE} before ./scripts/dev.sh if not already default"
      L2_PASS=1
      break
    fi
  done
  if [[ "$L2_PASS" -eq 0 ]]; then
    fail 2 "Neither streamid mode advanced HLS — Zixi input '${ZIXI_SRT_STREAM}' is not ingesting (infra/Zixi UI, not browser)"
    finish
  fi
else
  warn "verify-zixi-srt-ingest.sh missing — polling manifest twice instead"
  sleep 3
  seq_b="$(curl -sf "$HLS_URL" 2>/dev/null | awk -F: '/EXT-X-MEDIA-SEQUENCE/ {print $2}' | tr -d '\r' || true)"
  if [[ -n "$seq_a" && -n "$seq_b" && "$seq_a" != "$seq_b" ]]; then
    pass 2 "HLS media_sequence advanced (${seq_a}→${seq_b})"
  else
    fail 2 "HLS media_sequence stuck at ${seq_a:-?} — ingest not live on '${ZIXI_SRT_STREAM}'"
    finish
  fi
fi

# ── L3 HLS: segment decodable ─────────────────────────────────────
say "L3 — HLS output (segment decodable in browser/MSE?)"
if curl -sf "${API_BASE}/api/health" >/dev/null 2>&1; then
  PROBE="$(curl -sf "${API_BASE}/api/playback/probe?url=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${HLS_URL}'))")" 2>/dev/null || true)"
  if [[ -n "$PROBE" ]]; then
    echo "$PROBE" | python3 -c "
import json,sys
p=json.load(sys.stdin)
print('  · manifest_ok=%s segment_ok=%s decodable=%s' % (p.get('manifest_ok'), p.get('segment_ok'), p.get('segment_decodable')))
print('  · checks:', ', '.join(p.get('checks') or []))
if p.get('segment_video'): print('  · video:', p.get('segment_video'))
" 2>/dev/null || true
    DEC="$(echo "$PROBE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('segment_decodable'))" 2>/dev/null || echo "")"
    if [[ "$DEC" == "True" ]]; then
      pass 3 "HLS segment ffprobe OK (SPS/PPS present)"
    else
      fail 3 "HLS segment not MSE-decodable (missing SPS/PPS at chunk boundary)"
      finish
    fi
  else
    warn "API probe failed — is ./scripts/dev.sh running?"
  fi
else
  warn "API not up — skip L3 probe (start dev.sh for probe_decode)"
fi

# ── L2/L3 MoQ: relay + catalog path ───────────────────────────────
say "L2/L3 — MoQ ingest + subscribe (relay metrics)"
if curl -sf "${MOQ_RELAY_ADMIN}/metrics" >/dev/null 2>&1; then
  curl -sf "${MOQ_RELAY_ADMIN}/metrics" | grep -E "pubSubscribe(Success|Error)_total|pubSubscribeError_by_code|pubPublishNamespaceSuccess" | sed 's/^/  /' || true
  TNE="$(curl -sf "${MOQ_RELAY_ADMIN}/metrics" | awk '/track_not_exist/{print $2}' | head -1 || echo 0)"
  SS="$(curl -sf "${MOQ_RELAY_ADMIN}/metrics" | awk '/pubSubscribeSuccess_total/{print $2}' | head -1 || echo 0)"
  if [[ "${SS:-0}" -gt 0 ]]; then
    pass 2 "MoQ relay: subscribe succeeded at least once"
  elif [[ "${TNE:-0}" -gt 0 ]]; then
    warn "MoQ relay: historical track_not_exist errors ($TNE) — if browser now shows 'ready levels=1', catalog path is working"
  fi
  if curl -sf "${API_BASE}/api/moq/probe" >/dev/null 2>&1; then
    curl -sf "${API_BASE}/api/moq/probe" | python3 -m json.tool 2>/dev/null | sed 's/^/  /' || true
  fi
else
  warn "moqx admin not reachable"
fi

say "L3 — MoQ browser evidence (from your last diagnostics)"
cat <<'EOF'
  · Catalog OK if you see: ready levels=1
  · Playback OK if you see: first_frame=ok OR stats rendered>0
  · If catalog OK but no frames: problem is media delivery after subscribe (publisher forward, timing), NOT TLS or catalog subscribe
EOF

# ── L4: Browser (only if we got here) ─────────────────────────────
say "L4 — Browser player (only relevant if L1–L3 pass)"
cat <<'EOF'
  HLS: DevTools → Network → filter playback/fetch → segments HTTP 200, body > 0
  MoQ: diagnostics → ready → first_frame / stats rendered
  If L2 HLS failed, the player will wait forever on media_sequence — that is expected.
EOF

finish
