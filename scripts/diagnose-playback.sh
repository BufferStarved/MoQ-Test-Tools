#!/usr/bin/env bash
# Diagnose whether playback failures are encode/upload vs player/ingest output.
# Usage: ./scripts/diagnose-playback.sh [comparison_id_or_summary_json]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
ZIXI_SRT_STREAM="${ZIXI_SRT_STREAM:-SRT Test}"
MOQ_RELAY_ADMIN="${MOQ_RELAY_ADMIN:-http://34.28.164.90:8000}"
MEDIA="${MEDIA:-dummy.mp4}"

say() { printf '\n== %s ==\n' "$*"; }
pass() { printf '  [PASS] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*"; }
info() { printf '  [INFO] %s\n' "$*"; }

require_cmd() {
  for tool in "$@"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      fail "Missing required tool: $tool"
      exit 1
    fi
  done
}

require_cmd curl ffprobe python3

say "1) Source media (browser compatibility)"
if [[ ! -f "$MEDIA" ]]; then
  fail "Media not found: $MEDIA"
else
  PROFILE="$(ffprobe -hide_banner -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height -of csv=p=0 "$MEDIA" 2>/dev/null || true)"
  info "Video: $PROFILE"
  if [[ "$PROFILE" == *"yuv444p"* ]] || [[ "$PROFILE" == *"4:4:4"* ]]; then
    fail "Source uses yuv444p / 4:4:4 — most browsers cannot decode this in <video> / MSE."
    info "Fix: regenerate media with yuv420p (see README) or enable browser-compat transcode in upload."
  else
    pass "Source pixel format looks browser-friendly (yuv420p expected)."
  fi
fi

say "2) Latest benchmark encode/upload (did ffmpeg finish and send data?)"
SUMMARY_ARG="${1:-}"
SUMMARIES=()
if [[ -n "$SUMMARY_ARG" && -f "$SUMMARY_ARG" ]]; then
  SUMMARIES=("$SUMMARY_ARG")
elif [[ -n "$SUMMARY_ARG" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && SUMMARIES+=("$line")
  done < <(ls -t results/upload_*_"${SUMMARY_ARG}"*.summary.json 2>/dev/null || true)
else
  while IFS= read -r line; do
    [[ -n "$line" ]] && SUMMARIES+=("$line")
  done < <(ls -t results/upload_*.summary.json 2>/dev/null | head -4 || true)
fi

if [[ ${#SUMMARIES[@]} -eq 0 ]]; then
  warn "No summary.json found. Run a benchmark first."
else
  for summary in "${SUMMARIES[@]}"; do
    [[ -f "$summary" ]] || continue
    info "Summary: $summary"
    python3 - <<'PY' "$summary"
import json, sys
s = json.load(open(sys.argv[1]))
avg = s.get("averages", {})
thr = s.get("throughput", {})
print(f"  protocol={s.get('protocol')} endpoint={s.get('endpoint')}")
print(f"  samples={s.get('samples')} fps={avg.get('fps')} bitrate_kbps={avg.get('bitrate_kbps')}")
print(f"  bytes_sent={thr.get('total_bytes_sent')}")
ok = s.get('samples', 0) >= 10 and (thr.get('total_bytes_sent') or 0) > 50000
print('  [PASS] encode/upload sent data for ~full run' if ok else '  [FAIL] encode/upload looks short or empty')
PY
  done
fi

say "3) Zixi ingest output (HLS) — independent of our web player"
HLS_URL="http://${ZIXI_HOST}:7777/playback.m3u8?stream=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${ZIXI_SRT_STREAM}'))")"
info "Manifest: $HLS_URL"
HTTP_CODE="$(curl -s -o /tmp/diag-hls.m3u8 -w "%{http_code}" "$HLS_URL" || true)"
if [[ "$HTTP_CODE" == "200" ]] && grep -q "#EXTM3U" /tmp/diag-hls.m3u8; then
  pass "Zixi HLS manifest available (stream is/was live on '${ZIXI_SRT_STREAM}')."
  SEG_REL="$(grep -v '^#' /tmp/diag-hls.m3u8 | tail -1 | tr -d '\r')"
  SEG_URL="http://${ZIXI_HOST}:7777/${SEG_REL// /%20}"
  info "Latest segment: $SEG_URL"
  curl -s "$SEG_URL" -o /tmp/diag-hls.ts || true
  if [[ -s /tmp/diag-hls.ts ]]; then
    SZ=$(wc -c </tmp/diag-hls.ts | tr -d ' ')
    pass "Downloaded HLS segment (${SZ} bytes)."
    SEG_META="$(ffprobe -hide_banner -analyzeduration 100M -probesize 100M -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height -of csv=p=0 /tmp/diag-hls.ts 2>/dev/null || echo decode-failed)"
    info "Segment video: $SEG_META"
    if [[ "$SEG_META" == *"decode-failed"* ]] || [[ "$SEG_META" == *,0,"*"* ]] || [[ -z "$SEG_META" ]]; then
      fail "HLS segment is missing decodable H.264 params (often no SPS/PPS at segment start, or 4:4:4)."
      info "Try VLC on the manifest URL during a live encode. If VLC also shows black, ingest/packaging is the issue."
    else
      pass "HLS segment contains decodable H.264 metadata."
    fi
  else
    fail "Could not download HLS segment (stream may be offline)."
  fi
else
  fail "HLS manifest HTTP $HTTP_CODE — is SRT ingest live and stream ID '${ZIXI_SRT_STREAM}' correct?"
fi

say "3b) API playback probe (same path the browser uses)"
API_BASE="${API_BASE:-http://127.0.0.1:8000}"
PROBE_URL="${API_BASE}/api/playback/probe?url=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${HLS_URL}'))")"
info "Probe: $PROBE_URL"
if curl -sf "$PROBE_URL" -o /tmp/diag-probe.json 2>/dev/null; then
  python3 - <<'PY'
import json
p = json.load(open("/tmp/diag-probe.json"))
checks = ", ".join(p.get("checks") or [])
ok = p.get("manifest_ok") and p.get("segment_ok")
print(f"  manifest_ok={p.get('manifest_ok')} ({p.get('manifest_bytes')} bytes)")
print(f"  segment_ok={p.get('segment_ok')} ({p.get('segment_bytes')} bytes)")
print(f"  checks={checks}")
print("  [PASS] API can fetch manifest + segment" if ok else "  [FAIL] API probe failed — fix proxy/URL encoding before blaming the player")
PY
else
  warn "API not reachable at ${API_BASE}. Start ./scripts/dev.sh and re-run."
fi

say "4) MoQ relay (publish vs subscribe)"
if curl -sf "${MOQ_RELAY_ADMIN}/info" >/dev/null; then
  pass "moqx admin reachable at ${MOQ_RELAY_ADMIN}/info"
  curl -sf "${MOQ_RELAY_ADMIN}/metrics" 2>/dev/null | grep -E "pubSubscribe(Success|Error)_total|pubPublishNamespace(Success|Error)_total" || true
  info "If pubSubscribeError_total > 0 and Success = 0 during a run, the browser player is failing MoQ SUBSCRIBE (playback), not ffmpeg."
else
  warn "moqx admin not reachable from this machine (firewall). SSH to relay VM and run: curl -s http://127.0.0.1:8000/metrics | grep pubSubscribe"
fi

say "5) Decision guide"
cat <<'EOF'
  Encode/upload OK if: summary samples ≈ duration, fps ≈ 30, bytes_sent ≫ 0.
  Ingest OK if: Zixi manifest 200 during live encode OR Zixi recording ffprobe shows 1280x720.

  If encode OK + HLS segment undecodable → packaging/codec issue (not the React player).
  If encode OK + HLS segment decodable in VLC but not browser → player/MSE issue.
  If encode OK + moqx pubSubscribeError → MoQ subscription/interop issue (not ffmpeg).

  User checks that help:
  - During encode: Zixi UI (http://35.222.33.58:4444) — is "SRT Test" ONLINE?
  - During encode: open HLS manifest in VLC (not just the web UI).
  - During encode: relay logs — sudo docker logs moqx 2>&1 | tail -30
EOF
