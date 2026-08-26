#!/usr/bin/env bash
# Soak-test a WHIP publish and report fps/speed checkpoints.
#
# Exists to prove the libavformat/whip.c ENOBUFS abort (docs/WEBRTC-WHIP-ENOBUFS.md)
# is fixed: stock ffmpeg fails the whole session on one transient UDP send error,
# the patched build retries and keeps publishing.
#
#   FFMPEG=/path/to/patched/ffmpeg scripts/whip-soak-test.sh
#
# Env:
#   FFMPEG        ffmpeg binary to test            (default: ffmpeg on PATH)
#   DURATION      seconds to publish               (default: 120)
#   VBITRATE      video bitrate                    (default: 2500k)
#   GOP           keyframe interval in frames      (default: 60)
#   TS_BUFFER     -ts_buffer_size bytes, "" = off  (default: unset)
#   SIZE          source frame size                (default: 1280x720)
#   FPS           source frame rate                (default: 30)
#   LOGLEVEL      ffmpeg -loglevel                 (default: verbose)
#   LABEL         tag used in the log filename     (default: soak)
#   OUTDIR        where logs land                  (default: /tmp/whip-soak)
#   SATURATE      off | pulse | full               (default: off)
#   SAT_TARGET    host for cross-traffic           (default: default gateway)
#   SAT_PULSE_MS  saturating burst length          (default: 150)
#   SAT_GAP_MS    quiet gap between bursts         (default: 1350)
#
# LOGLEVEL defaults to verbose because the patched binary logs a successful
# retry ("UDP send queue drained after %dms") at AV_LOG_VERBOSE. At the old
# default of `warning` a run could exercise the retry path and look identical
# to a run that never hit ENOBUFS at all, which is exactly the distinction
# this script exists to make.
#
# SATURATE exists because waiting for the transmit queue to overflow on its own
# is not a test, it is a coin flip - on a strong Wi-Fi link the queue drains far
# too fast to overflow. ENOBUFS is raised by ifnet_enqueue() when the *interface*
# transmit queue is full, so the only reliable way to provoke it is to enqueue
# faster than the radio drains. `pulse` blasts UDP at the local gateway in short
# bursts, which fills the queue repeatedly without drowning the whole run, and
# leaves quiet gaps in which a retry can actually succeed. Traffic stays on the
# LAN so nothing is inflicted on the WAN or on the WHIP origin.
set -uo pipefail

URL="${1:-http://34.9.217.178:8889/benchmark-whipsoak/whip}"
FFMPEG="${FFMPEG:-ffmpeg}"
DURATION="${DURATION:-120}"
VBITRATE="${VBITRATE:-2500k}"
GOP="${GOP:-60}"
SIZE="${SIZE:-1280x720}"
FPS="${FPS:-30}"
LOGLEVEL="${LOGLEVEL:-verbose}"
LABEL="${LABEL:-soak}"
OUTDIR="${OUTDIR:-/tmp/whip-soak}"
SATURATE="${SATURATE:-off}"
SAT_PULSE_MS="${SAT_PULSE_MS:-150}"
SAT_GAP_MS="${SAT_GAP_MS:-1350}"

mkdir -p "$OUTDIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
BASE="$OUTDIR/${LABEL}-${STAMP}"
PROGRESS="$BASE.progress"
ERRLOG="$BASE.stderr"
SATLOG="$BASE.saturator"

echo "== WHIP soak =="
echo "ffmpeg    : $FFMPEG"
"$FFMPEG" -version 2>/dev/null | head -1
echo "url       : $URL"
echo "duration  : ${DURATION}s   source: ${SIZE}p${FPS}   bitrate: $VBITRATE   gop: $GOP   ts_buffer: ${TS_BUFFER:-<default>}"
echo "loglevel  : $LOGLEVEL"
# The bug only reproduces on Wi-Fi, so record which interface actually carried
# the traffic rather than assuming it.
URL_HOST="${URL#*://}"; URL_HOST="${URL_HOST%%/*}"; URL_HOST="${URL_HOST%%:*}"
echo "iface     : $(route -n get "$URL_HOST" 2>/dev/null | awk -F': +' '/interface/{print $2}')"
if [[ "$SATURATE" == "pulse" ]]; then
  echo "saturate  : pulse (${SAT_PULSE_MS}ms burst / ${SAT_GAP_MS}ms gap)"
else
  echo "saturate  : $SATURATE"
fi
echo "logs      : $BASE.*"
echo

# bash 3.2 (macOS system bash) treats "${arr[@]}" on an empty array as unbound
# under set -u, so build the flag as a plain string and word-split it instead.
TS_ARGS=""
if [[ -n "${TS_BUFFER:-}" ]]; then
  TS_ARGS="-ts_buffer_size $TS_BUFFER"
fi

# ---------------------------------------------------------------------------
# Cross-traffic generator (see SATURATE note above).
# ---------------------------------------------------------------------------
SAT_PID=""
start_saturator() {
  [[ "$SATURATE" == "off" ]] && return 0
  if ! command -v python3 >/dev/null 2>&1; then
    echo "WARNING: SATURATE=$SATURATE requested but python3 is missing; running without cross-traffic"
    SATURATE=off
    return 0
  fi
  local target="${SAT_TARGET:-$(route -n get default 2>/dev/null | awk -F': +' '/gateway/{print $2}')}"
  if [[ -z "$target" ]]; then
    echo "WARNING: could not determine a saturation target; running without cross-traffic"
    SATURATE=off
    return 0
  fi
  cat > "$OUTDIR/.saturator.py" <<'PY'
import errno, signal, socket, sys, time

target, port, mode = sys.argv[1], int(sys.argv[2]), sys.argv[3]
pulse, gap, deadline = float(sys.argv[4]) / 1000.0, float(sys.argv[5]) / 1000.0, float(sys.argv[6])

pkt = b"x" * 1200
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.connect((target, port))
s.setblocking(False)

sent = blocked = bursts = 0


# The run stops us as soon as ffmpeg exits, which is before our own deadline.
# Without this the counters die with the process and the log is empty, leaving
# no record of whether cross-traffic was actually applied.
def report(*_):
    print(f"saturator target={target}:{port} mode={mode} bursts={bursts} "
          f"sent={sent} blocked={blocked}", flush=True)
    sys.exit(0)


signal.signal(signal.SIGTERM, report)
signal.signal(signal.SIGINT, report)
while time.time() < deadline:
    t0 = time.monotonic()
    span = pulse if mode == "pulse" else 1.0
    while time.monotonic() - t0 < span and time.time() < deadline:
        try:
            s.send(pkt)
            sent += 1
        except OSError as e:
            if e.errno in (errno.ENOBUFS, errno.EAGAIN):
                blocked += 1
    bursts += 1
    if mode == "pulse":
        time.sleep(gap)
report()
PY
  python3 "$OUTDIR/.saturator.py" "$target" 39999 "$SATURATE" \
    "$SAT_PULSE_MS" "$SAT_GAP_MS" "$(( $(date +%s) + DURATION + 5 ))" \
    > "$SATLOG" 2>&1 &
  SAT_PID=$!
  echo "saturator : pid $SAT_PID -> $target:39999"
}
stop_saturator() {
  [[ -n "$SAT_PID" ]] && kill "$SAT_PID" 2>/dev/null
  wait "$SAT_PID" 2>/dev/null
  SAT_PID=""
}
trap stop_saturator EXIT INT TERM

# ---------------------------------------------------------------------------
# Run.
# ---------------------------------------------------------------------------
# caffeinate: this machine runs lid-closed on AC and takes "Maintenance Sleep"
# naps every few minutes. A nap freezes ffmpeg while Darwin's CLOCK_MONOTONIC
# keeps counting, so on wake whip.c sees consent stale by the whole nap and
# kills the session with ETIMEDOUT - a host artifact that looks exactly like a
# network failure. Hold power assertions for the run, and verify afterwards.
# -nostdin + </dev/null: keep ffmpeg off the terminal so a background run can
# never take SIGTTIN.
CAFF=""
command -v caffeinate >/dev/null 2>&1 && CAFF="caffeinate -dims"

START="$(date +%s)"
START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
start_saturator

# testsrc2 + sine keeps the encoder busy without needing a capture device, and
# matches the source the original ENOBUFS repro used.
$CAFF "$FFMPEG" -hide_banner -loglevel "$LOGLEVEL" -nostdin \
  -re -f lavfi -i "testsrc2=size=${SIZE}:rate=${FPS}" \
  -re -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t "$DURATION" \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v baseline \
  -pix_fmt yuv420p -b:v "$VBITRATE" -maxrate "$VBITRATE" -bufsize "$VBITRATE" \
  -g "$GOP" -keyint_min "$GOP" -sc_threshold 0 \
  -c:a libopus -b:a 64k -ar 48000 -ac 2 \
  $TS_ARGS \
  -f whip "$URL" \
  -nostats -progress "$PROGRESS" \
  < /dev/null 2> "$ERRLOG"
RC=$?
END="$(date +%s)"
END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
ELAPSED=$(( END - START ))
stop_saturator

echo
echo "== result =="
# ffmpeg exits with its negative AVERROR, so the shell sees 256+ret. Decode the
# common ones: a bare "rc=196" reads like an ENOBUFS repro when it is nothing of
# the kind.
case "$RC" in
  0)   RCNAME="success" ;;
  196) RCNAME="ffmpeg -60 ETIMEDOUT (ICE consent freshness expired)" ;;
  201) RCNAME="ffmpeg -55 ENOBUFS (no buffer space available)" ;;
  221) RCNAME="ffmpeg -35 EAGAIN (resource temporarily unavailable)" ;;
  *)   RCNAME="ffmpeg $(( RC - 256 ))" ;;
esac
echo "exit code : $RC   ($RCNAME)"
echo "wall time : ${ELAPSED}s of ${DURATION}s requested"

# -progress emits repeating key=value blocks terminated by "progress=".
# Pull the last sample at or before each checkpoint second.
if [[ -s "$PROGRESS" ]]; then
  echo
  echo "checkpoint   out_time     fps     speed"
  awk -v dur="$DURATION" '
    /^out_time_ms=/ { split($0,a,"="); t = a[2]/1000000 }
    /^fps=/         { split($0,a,"="); f = a[2] }
    /^speed=/       { split($0,a,"="); s = a[2] }
    /^progress=/    { if (t != "") { sec = int(t); last[sec] = sprintf("%-12s %-7s %-7s", sprintf("%.1fs", t), f, s); if (sec > maxsec) maxsec = sec } }
    END {
      n = split("20 40 60 90 120", cps, " ")
      for (i = 1; i <= n; i++) {
        c = cps[i] + 0
        if (c > dur) continue
        # walk back to the newest sample at or before the checkpoint
        for (k = c; k >= 0; k--) if (k in last) { printf "  %-10s %s\n", c "s", last[k]; break }
        if (k < 0) printf "  %-10s %s\n", c "s", "(no sample - died before this point)"
      }
      if (maxsec in last) printf "  %-10s %s\n", "final", last[maxsec]
      printf "\nlast progress sample at %ds\n", maxsec
    }
  ' "$PROGRESS"
else
  echo "(no progress samples written)"
fi

# ---------------------------------------------------------------------------
# Host-freeze gate. Runs 2026-08-22 21:06-21:26 all "failed" with ETIMEDOUT
# purely because the Mac napped mid-run; without this check that is
# indistinguishable from a network fault, and it silently invalidates the run.
# In-band detector: ffmpeg's own "Resumed reading ... after a lag of Ns" line.
# ~1.4s of lag at startup is normal pipeline fill; seconds of it is a freeze.
# ---------------------------------------------------------------------------
echo
echo "== host freeze check =="
MAXLAG="$(awk 'match($0, /after a lag of [0-9.]+s/) {
                 v = substr($0, RSTART + 15, RLENGTH - 16) + 0; if (v > m) m = v
               } END { printf "%.3f", m + 0 }' "$ERRLOG" 2>/dev/null)"
echo "max input-thread lag : ${MAXLAG}s"
NAPS="$(pmset -g log 2>/dev/null | awk -v s="$START_TS" -v e="$END_TS" '
          /Entering (Sleep|DarkWake) state/ { ts = substr($0, 1, 19); if (ts >= s && ts <= e) print "  " $0 }')"
if [[ -n "$NAPS" ]]; then
  echo "system sleep during run:"
  echo "$NAPS"
fi
STALLED=0
if awk -v m="$MAXLAG" 'BEGIN { exit !(m > 3.0) }'; then
  STALLED=1
  echo "VERDICT: RUN INVALID - host froze for ${MAXLAG}s mid-run (system sleep or suspend)."
  echo "         Whatever ffmpeg reported after that point is an artifact, not a network"
  echo "         result. Keep the lid open / hold a power assertion and re-run."
fi

echo
ABORTED=0
if [[ "$STALLED" -eq 1 ]]; then
  : # already reported; do not layer a second, misleading verdict on top
elif [[ "$RC" -ne 0 ]] && grep -qE 'ret=-55|No buffer space|ENOBUFS' "$ERRLOG" 2>/dev/null; then
  ABORTED=1
  echo "VERDICT: ENOBUFS ABORT REPRODUCED"
  grep -E 'ret=-55|No buffer space|Failed to write packet|Conversion failed' "$ERRLOG" | head -5
elif [[ "$RC" -ne 0 ]]; then
  echo "VERDICT: FAILED ($RCNAME), not the ENOBUFS signature"
  tail -5 "$ERRLOG"
elif [[ "$ELAPSED" -lt $(( DURATION - 5 )) ]]; then
  echo "VERDICT: EXITED EARLY at ${ELAPSED}s without an error code"
else
  echo "VERDICT: SURVIVED ${ELAPSED}s"
fi

# A clean 120s run proves nothing on its own - it may just mean the link was
# calm and the retry path never ran. These four counters are what separates
# "survived" from "survived AND demonstrably exercised the fix". The strings
# match the patch verbatim; anything else silently reports zero forever.
echo
echo "== send-path events =="
# grep -c already prints 0 on no-match (and exits 1), so swallow the status
# rather than `|| echo 0`, which would emit a second line and break -eq below.
count() { grep -cF "$1" "$ERRLOG" 2>/dev/null | head -1; }
DRAINED="$(count 'UDP send queue drained after')"      # retry succeeded (verbose)
STILLFULL="$(count 'UDP send queue still full after')" # retry budget exhausted
DROPPED="$(count 'Dropped packet=')"                   # packet dropped, session kept
CONSENT="$(count 'Skipped Consent Freshness check')"
printf "  retry succeeded (queue drained) : %s\n" "$DRAINED"
printf "  retry budget exhausted          : %s\n" "$STILLFULL"
printf "  packets dropped (session kept)  : %s\n" "$DROPPED"
printf "  consent checks skipped          : %s\n" "$CONSENT"
[[ -s "$SATLOG" ]] && printf "  %s\n" "$(cat "$SATLOG")"

ENGAGED=$(( DRAINED + STILLFULL + DROPPED ))
if [[ "$ENGAGED" -eq 0 && "$ABORTED" -eq 0 ]]; then
  echo "  NOTE: retry path never engaged - this run says nothing about the fix."
  if [[ "$LOGLEVEL" != "verbose" && "$LOGLEVEL" != "debug" && "$LOGLEVEL" != "trace" ]]; then
    echo "        (and LOGLEVEL=$LOGLEVEL is too coarse to log a successful retry)"
  fi
  if [[ "$SATURATE" == "off" ]]; then
    echo "        Set SATURATE=pulse to force the transmit queue to overflow."
  fi
fi

# The single line worth quoting. "Survived" and "survived AND proved the fix
# ran" are different claims and conflating them is how a calm link gets written
# up as a pass.
echo
if [[ "$STALLED" -eq 1 ]]; then
  echo "OVERALL: INVALID - host froze mid-run, no conclusion available"
elif [[ "$ABORTED" -eq 1 ]]; then
  echo "OVERALL: ABORTED on ENOBUFS after ${ELAPSED}s - the bug, reproduced"
elif [[ "$RC" -ne 0 ]]; then
  echo "OVERALL: FAILED after ${ELAPSED}s ($RCNAME)"
elif [[ "$ENGAGED" -gt 0 ]]; then
  echo "OVERALL: PASS - survived ${ELAPSED}s AND exercised the retry path" \
       "($DRAINED drained, $STILLFULL exhausted, $DROPPED dropped)"
else
  echo "OVERALL: INCONCLUSIVE - survived ${ELAPSED}s but never hit the error path"
fi

exit "$RC"
