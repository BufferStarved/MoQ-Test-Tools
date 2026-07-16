#!/usr/bin/env bash
# One-page playback verdict — no layers, no ambiguity.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ZIXI_HOST="${ZIXI_HOST:-35.222.33.58}"
HLS_URL="http://${ZIXI_HOST}:7777/playback.m3u8?stream=SRT%20Test"
MOQ_ADMIN="${MOQ_RELAY_ADMIN:-http://34.28.164.90:8000}"

say() { printf '\n%s\n' "$*"; }

say "PLAYBACK VERDICT"
say "================"

say "HLS (SRT → Zixi)"
if [[ -x "$ROOT_DIR/scripts/verify-zixi-srt-ingest.sh" ]]; then
  set +e
  OUT="$("$ROOT_DIR/scripts/verify-zixi-srt-ingest.sh" 2>&1)"
  CODE=$?
  set -e
  echo "$OUT" | tail -6 | sed 's/^/  /'
  if [[ "$CODE" -eq 0 ]]; then
    say "  → HLS: READY for browser playback"
  else
    say "  → HLS: NOT READY (fix verify output above before debugging the player)"
  fi
else
  say "  verify-zixi-srt-ingest.sh missing"
fi

say ""
say "MoQ (relay)"
set +e
MOQ_METRICS="$(curl -sf --max-time 10 "${MOQ_ADMIN}/metrics" 2>/dev/null)"
MOQ_CURL=$?
set -e
moq_metric() {
  echo "$MOQ_METRICS" | awk -v name="$1" '!/^#/ && $1 == name { print $2; exit }'
}
if [[ "$MOQ_CURL" -eq 0 && -n "$MOQ_METRICS" ]]; then
  TNE="$(echo "$MOQ_METRICS" | awk '/^moqx_pubSubscribeError_by_code_total\{code="track_not_exist"\}/{print $2; exit}')"
  SS="$(moq_metric moqx_pubSubscribeSuccess_total)"
  PR="$(moq_metric moqx_moqPublishReceived_total)"
  say "  relay subscribe_success=${SS:-0} track_not_exist_errors=${TNE:-0} publish_received=${PR:-0} (cumulative)"
  if command -v "$ROOT_DIR/tools/openmoq-publisher/bin/openmoq-publisher" >/dev/null 2>&1; then
    say "  publisher: openmoq-publisher (forward=1 + publish-catalog)"
  elif command -v "$ROOT_DIR/tools/moq5-publisher/bin/moq5-fmp4-publish" >/dev/null 2>&1; then
    say "  publisher: moq5-fmp4-publish only (experimental — set MOQ_PUBLISHER_BACKEND=openmoq if available)"
  else
    say "  publisher: MISSING — run ./scripts/install-moq5.sh (preferred) or ./scripts/install-openmoq-publisher.sh"
  fi
  say "  player: @playa/player (Chrome/Edge WebTransport)"
  say "  → MoQ: restart ./scripts/dev.sh after API changes, then run a fresh 30s benchmark"
  say "  → Catalog should load within ~5s of encode start; if not, check API log for openmoq stderr"
else
  say "  relay admin unreachable at ${MOQ_ADMIN}"
fi

say ""
say "Before browser testing:"
say "  1. ./scripts/dev.sh   (restart — picks up direct ffmpeg→SRT upload)"
say "  2. ./scripts/verify-zixi-srt-ingest.sh   (must PASS)"
say "  3. Fresh 30s benchmark on http://127.0.0.1:5173"
