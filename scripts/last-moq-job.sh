#!/usr/bin/env bash
# Print the newest $TMPDIR/moq-bench-* logs and whether hop-2 was video copy.
set -euo pipefail

TMP="${TMPDIR:-/tmp}"
DIR="$(ls -td "$TMP"/moq-bench-* 2>/dev/null | head -1 || true)"
if [[ -z "$DIR" ]]; then
  echo "No moq-bench-* under $TMP" >&2
  exit 1
fi

echo "job dir: $DIR"
echo

FFMPEG_LOG="$DIR/ffmpeg-stderr.log"
PUB_LOG="$DIR/publisher-stderr.log"

if [[ -f "$FFMPEG_LOG" ]]; then
  echo "=== ffmpeg mapping ==="
  grep -E 'Stream mapping:|Stream #0:|-> |Conversion failed|dimensions not set|Malformed AAC|error' "$FFMPEG_LOG" | head -40
  echo
  if grep -q 'Stream #0:0 -> #0:0 (copy)' "$FFMPEG_LOG"; then
    echo "verdict: video copy OK"
  elif grep -q 'libx264' "$FFMPEG_LOG" && grep -q 'Stream #0:0 ->' "$FFMPEG_LOG"; then
    echo "verdict: still libx264 (stale helper or not webcam UDP)"
  else
    echo "verdict: no h264 mapping line yet (probe / early exit)"
  fi
else
  echo "missing $FFMPEG_LOG"
fi

echo
if [[ -f "$PUB_LOG" ]]; then
  echo "=== vide group wall_dt (ms) ==="
  if grep -q 'obj vide wall_dt_ms=' "$PUB_LOG"; then
    python3 -c '
import sys
dts = []
for line in open(sys.argv[1]):
    if "obj vide wall_dt_ms=" not in line:
        continue
    for part in line.split():
        if part.startswith("wall_dt_ms="):
            v = int(part.split("=", 1)[1])
            if v >= 0:
                dts.append(v)
if not dts:
    print("no cadence samples")
else:
    dts.sort()
    n = len(dts)
    print("n", n, "min", dts[0], "p50", dts[n//2], "p90", dts[int(n*0.9)], "max", dts[-1])
    over = sum(1 for x in dts if x > 800)
    under = sum(1 for x in dts if 0 <= x < 250)
    print("dt>800ms", over, "dt<250ms", under)
' "$PUB_LOG"
  else
    echo "(no obj vide lines — publisher binary may be stale)"
  fi
  echo
  echo "=== publisher (tail) ==="
  tail -n 20 "$PUB_LOG"
else
  echo "missing $PUB_LOG"
fi
