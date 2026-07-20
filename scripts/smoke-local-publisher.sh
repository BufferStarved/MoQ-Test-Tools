#!/usr/bin/env bash
# Integration / e2e smoke for local publisher agent + API.
# Requires: API with LOCAL_PUBLISHER_ENABLED=1 and a connected agent.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

API="${LOCAL_PUBLISHER_API:-http://127.0.0.1:8000}"
DURATION="${DURATION:-8}"
FFMPEG_BIN="${FFMPEG:-ffmpeg}"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS $*"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $*"; }

echo "== Local publisher smoke against $API =="

FEATURES=$(curl -fsS -m 5 "$API/api/features")
echo "$FEATURES" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("local_publisher"), d; print("enabled", d["local_publisher"], "connected", d.get("local_publisher_connected"))'
ok "features local_publisher enabled"

CONNECTED=$(echo "$FEATURES" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("local_publisher_connected"))')
if [[ "$CONNECTED" != "True" ]]; then
  bad "agent not connected — start ./scripts/run-local-publisher.sh"
  echo "PASS=$PASS FAIL=$FAIL"
  exit 1
fi
ok "agent connected"

# Synthetic clip (not a VOD preset path) so local-file gate accepts it.
CLIP="$ROOT_DIR/uploads/qa-local-publisher-smoke.mp4"
mkdir -p "$ROOT_DIR/uploads"
"$FFMPEG_BIN" -y -hide_banner -loglevel error \
  -f lavfi -i "testsrc=size=640x360:rate=30" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
  -c:v libx264 -pix_fmt yuv420p -preset ultrafast -t 6 \
  -c:a aac -shortest "$CLIP"
ok "generated clip $CLIP"

UPLOAD_JSON=$(curl -fsS -m 30 -F "file=@${CLIP};filename=qa-smoke.mp4" "$API/api/media/upload")
MEDIA_PATH=$(echo "$UPLOAD_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["media_path"])')
ok "media upload → $MEDIA_PATH"

# Reject VOD for local (negative gate)
CODE=$(curl -sS -m 10 -o /tmp/moq_local_vod.json -w "%{http_code}" \
  -H 'Content-Type: application/json' \
  -d '{"media_path":"dummy.mp4","preset_id":"moq_mediamtx_gcp_srt","duration_sec":5,"publisher_host":"local"}' \
  "$API/api/uploads" || true)
[[ "$CODE" == "400" ]] && ok "rejects VOD for local" || bad "expected 400 for VOD got $CODE"

JOB_JSON=$(curl -fsS -m 15 -H 'Content-Type: application/json' \
  -d "{\"media_path\":\"${MEDIA_PATH}\",\"preset_id\":\"moq_mediamtx_gcp_srt\",\"duration_sec\":${DURATION},\"publisher_host\":\"local\",\"encode_ladder\":\"720p\",\"target_latency_ms\":800}" \
  "$API/api/uploads")
JOB_ID=$(echo "$JOB_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or d.get("job_id") or "")')
[[ -n "$JOB_ID" ]] || { bad "create upload missing id: $JOB_JSON"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; }
ok "created local job $JOB_ID"

STATUS="queued"
HLS_SEEN=0
for _ in $(seq 1 60); do
  STATUS=$(curl -fsS -m 5 "$API/api/uploads/$JOB_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))')
  echo "  status=$STATUS"
  if [[ "$HLS_SEEN" -eq 0 ]]; then
    HLS=$(curl -sS -m 3 -o /dev/null -w "%{http_code}" "http://34.9.217.178:8888/benchmark/index.m3u8" || echo 000)
    if [[ "$HLS" == "200" ]]; then
      HLS_SEEN=1
      ok "MediaMTX LL-HLS reachable mid-job ($HLS)"
    fi
  fi
  case "$STATUS" in
    completed|failed|cancelled) break ;;
  esac
  sleep 2
done

SUMMARY=$(curl -fsS -m 10 "$API/api/uploads/$JOB_ID")
if echo "$SUMMARY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("final", d.get("status"), "error", d.get("error"), "samples", len(d.get("samples") or [])); print("csv", d.get("csv_path") or ""); sys.exit(0 if d.get("status")=="completed" and len(d.get("samples") or [])>0 else 1)'; then
  ok "job completed with samples"
else
  bad "job did not complete: $STATUS"
  echo "$SUMMARY" | head -c 2000
  echo
fi

if [[ "$HLS_SEEN" -eq 0 ]]; then
  # Idle MediaMTX paths often 404 after the publisher stops — warn, don't fail the smoke.
  echo "WARN MediaMTX LL-HLS never returned 200 during the short job (may be race / idle path)"
fi

echo "PASS=$PASS FAIL=$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
