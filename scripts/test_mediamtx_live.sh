#!/usr/bin/env bash
# Comprehensive live smoke for MediaMTX on moq-web (run via gcloud ssh).
set -uo pipefail

HOST_IP="${HOST_IP:-34.9.217.178}"
PATH_NAME="${PATH_NAME:-benchmark}"
PYTHON="${PYTHON:-/opt/moq-test-tools/.venv/bin/python3}"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="$(command -v python3)"
fi
PASS=0
FAIL=0
WARN=0

ok() { PASS=$((PASS + 1)); echo "  PASS  $*"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $*"; }
warn() { WARN=$((WARN + 1)); echo "  WARN  $*"; }

section() { echo; echo "== $* =="; }

http_code() {
  curl -sS -o /tmp/mtx_body -w "%{http_code}" --max-time "${2:-5}" "$1" 2>/dev/null || echo "000"
}

section "Services"
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qi mediamtx; then
  ok "MediaMTX docker container running"
  docker ps --format '  {{.Names}} {{.Status}}' | grep -i mediamtx || true
else
  bad "MediaMTX docker container not running"
fi

if systemctl is-active --quiet moq-mediamtx-lldash 2>/dev/null; then
  ok "moq-mediamtx-lldash active"
else
  bad "moq-mediamtx-lldash inactive"
fi

if systemctl is-active --quiet moq-web 2>/dev/null; then
  ok "moq-web active"
else
  bad "moq-web inactive"
fi

section "Local endpoints (idle)"
for url in \
  "http://127.0.0.1:9998/metrics" \
  "http://127.0.0.1:9997/v3/paths/list" \
  "http://127.0.0.1:8000/api/health"
do
  code=$(http_code "$url")
  if [[ "$code" == "200" ]]; then ok "$url → $code"; else bad "$url → $code"; fi
done

code=$(http_code "http://127.0.0.1:8888/${PATH_NAME}/index.m3u8")
if [[ "$code" == "200" ]]; then ok "idle LL-HLS present ($code)"; else warn "idle LL-HLS $code (expected until publish)"; fi

section "SRT publish → delivery + metrics"
if ! command -v ffmpeg >/dev/null 2>&1; then
  bad "ffmpeg missing"
else
  ffmpeg -hide_banner -loglevel warning -re \
    -f lavfi -i "testsrc=size=1280x720:rate=30" \
    -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
    -c:v libx264 -preset veryfast -tune zerolatency -b:v 2500k -g 60 -keyint_min 60 \
    -c:a aac -b:a 128k -f mpegts \
    "srt://127.0.0.1:8890?mode=caller&latency=200000&streamid=publish:${PATH_NAME}" \
    >/tmp/mtx_srt_pub.log 2>&1 &
  FFPID=$!

  sleep 7

  READY=$(curl -sS --max-time 3 "http://127.0.0.1:9997/v3/paths/get/${PATH_NAME}" \
    | "$PYTHON" -c 'import sys,json; d=json.load(sys.stdin); print(str(d.get("ready")).lower())' 2>/dev/null || echo "err")
  if [[ "$READY" == "true" ]]; then ok "path ready after SRT publish"; else bad "path ready=$READY"; fi

  HLS_CODE=$(http_code "http://127.0.0.1:8888/${PATH_NAME}/index.m3u8")
  if [[ "$HLS_CODE" == "200" ]]; then
    ok "LL-HLS playlist HTTP $HLS_CODE"
    if grep -q "EXTM3U" /tmp/mtx_body; then ok "LL-HLS has EXTM3U"; else bad "LL-HLS missing EXTM3U"; fi
    if grep -qE "EXT-X-PART|EXTINF|#EXT-X-STREAM-INF" /tmp/mtx_body; then
      ok "LL-HLS has PART/EXTINF/STREAM-INF"
    else
      warn "LL-HLS missing PART/EXTINF/STREAM-INF"
    fi
  else
    bad "LL-HLS playlist HTTP $HLS_CODE"
  fi

  if "$PYTHON" - <<'PY'
import sys
sys.path.insert(0, "/opt/moq-test-tools/src")
from zixi_hls_health import probe_hls_segment_ready
h = probe_hls_segment_ready("http://127.0.0.1:8888/benchmark/index.m3u8")
print(f"hls_health ok={h.ok} detail={h.detail} seq={h.media_sequence}")
sys.exit(0 if h.ok else 1)
PY
  then ok "HLS segment probe ready"; else bad "HLS segment probe not ready"; fi

  DASH_OK=0
  for _i in $(seq 1 15); do
    DCODE=$(http_code "http://127.0.0.1:8891/${PATH_NAME}/manifest.mpd")
    if [[ "$DCODE" == "200" ]] && grep -qiE "MPD|AdaptationSet" /tmp/mtx_body; then
      DASH_OK=1
      break
    fi
    sleep 2
  done
  if [[ "$DASH_OK" -eq 1 ]]; then ok "LL-DASH manifest HTTP 200"; else bad "LL-DASH manifest not ready (last=$DCODE)"; fi

  WHEP_CODE=$(http_code "http://127.0.0.1:8889/${PATH_NAME}/whep")
  if [[ "$WHEP_CODE" != "000" && "$WHEP_CODE" != "404" ]]; then
    ok "WHEP endpoint reachable (HTTP $WHEP_CODE)"
  else
    bad "WHEP endpoint HTTP $WHEP_CODE"
  fi

  if "$PYTHON" - <<'PY'
import sys, time
sys.path.insert(0, "/opt/moq-test-tools/src")
from mediamtx_stats import MediaMtxStatsPoller
from upload_service import UploadService

p = MediaMtxStatsPoller(endpoint_url="srt://127.0.0.1:8890?streamid=publish:benchmark")
p.poll()
time.sleep(1.2)
snap = p.poll()
merged = UploadService._merge_mediamtx_transport(
    mtx=snap,
    net_rtt_ms=0.0,
    net_jitter_ms=0.0,
    net_send_mbps=0.0,
    net_recv_mbps=0.0,
)
print(
    "ready={ready} rtt={rtt} jitter={jit} recv_mbps={recv} loss={loss} "
    "retrans={rtx} pkt_retrans={pr} drops={dr} bytes_rx={br}".format(
        ready=snap.ready,
        rtt=round(snap.net_rtt_ms, 3),
        jit=round(snap.net_jitter_ms, 3),
        recv=round(snap.net_recv_mbps, 3),
        loss=round(snap.net_loss_pct, 3),
        rtx=round(snap.net_retrans_pct, 3),
        pr=snap.pkt_retrans,
        dr=snap.pkt_rcv_drop,
        br=snap.bytes_received,
    )
)
print("merged_recv", round(merged["net_recv_mbps"], 3), "merged_rtt", round(merged["net_rtt_ms"], 3))
ok = bool(snap.ready and (snap.net_recv_mbps > 0 or snap.bytes_received > 0))
if snap.net_rtt_ms <= 0:
    print("note: srt RTT not present yet")
sys.exit(0 if ok else 1)
PY
  then ok "metrics poller mapped ingest traffic"; else bad "metrics poller saw no ingest"; fi

  kill "$FFPID" 2>/dev/null || true
  wait "$FFPID" 2>/dev/null || true
  sleep 2
fi

section "RTMP publish → path ready + recv rate"
if command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg -hide_banner -loglevel warning -re \
    -f lavfi -i "testsrc=size=640x360:rate=30" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -c:v libx264 -preset veryfast -tune zerolatency -b:v 1200k -g 60 \
    -c:a aac -b:a 96k -f flv \
    "rtmp://127.0.0.1:1935/${PATH_NAME}" \
    >/tmp/mtx_rtmp_pub.log 2>&1 &
  RTMP_PID=$!
  sleep 8
  if "$PYTHON" - <<'PY'
import sys, time
sys.path.insert(0, "/opt/moq-test-tools/src")
from mediamtx_stats import MediaMtxStatsPoller
p = MediaMtxStatsPoller(endpoint_url="rtmp://127.0.0.1:1935/benchmark")
p.poll(); time.sleep(1.2); snap = p.poll()
print(f"rtmp ready={snap.ready} recv_mbps={snap.net_recv_mbps:.3f} bytes={snap.bytes_received}")
sys.exit(0 if snap.ready and (snap.net_recv_mbps > 0 or snap.bytes_received > 0) else 1)
PY
  then ok "RTMP ingest metrics mapped"; else bad "RTMP ingest metrics missing"; fi
  HLS2=$(http_code "http://127.0.0.1:8888/${PATH_NAME}/index.m3u8")
  if [[ "$HLS2" == "200" ]]; then ok "LL-HLS after RTMP HTTP $HLS2"; else bad "LL-HLS after RTMP HTTP $HLS2"; fi
  kill "$RTMP_PID" 2>/dev/null || true
  wait "$RTMP_PID" 2>/dev/null || true
fi

section "Public API presets"
curl -sS --max-time 5 "http://127.0.0.1:8000/api/presets" -o /tmp/mtx_presets.json || true
if "$PYTHON" - <<'PY'
import json, sys
data = json.load(open("/tmp/mtx_presets.json"))
ids = {p.get("id") for p in data.get("presets", [])}
need = {"moq_mediamtx_gcp_srt", "moq_mediamtx_gcp_rtmp", "moq_mediamtx_gcp_whip"}
missing = sorted(need - ids)
if missing:
    print("missing", missing)
    sys.exit(1)
for pid in sorted(need):
    p = next(x for x in data["presets"] if x["id"] == pid)
    print(pid, p.get("protocol"), (p.get("url") or "")[:72])
sys.exit(0)
PY
then ok "MediaMTX presets exposed"; else bad "MediaMTX presets missing"; fi

section "Summary"
echo "PASS=$PASS FAIL=$FAIL WARN=$WARN"
if [[ "$FAIL" -gt 0 ]]; then exit 1; fi
exit 0
