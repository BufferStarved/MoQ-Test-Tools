#!/usr/bin/env bash
# Compute VMAF on the ingest host using ffmpeg libvmaf.
# Usage: compute-vmaf-on-ingest.sh <reference> <recording_dir> <start_epoch> <end_epoch> <work_dir>
set -euo pipefail

REFERENCE="${1:?reference file required}"
RECORDING_DIR="${2:?recording dir required}"
START_EPOCH="${3:?start epoch required}"
END_EPOCH="${4:?end epoch required}"
WORK_DIR="${5:-/tmp/moq-vmaf}"

mkdir -p "$WORK_DIR"

FFMPEG="${FFMPEG:-}"
if [[ -z "$FFMPEG" ]]; then
  for candidate in /usr/local/bin/ffmpeg /usr/bin/ffmpeg ffmpeg; do
    if [[ -x "$candidate" ]] && "$candidate" -hide_banner -filters 2>/dev/null | grep -qw libvmaf; then
      FFMPEG="$candidate"
      break
    fi
  done
fi

if [[ -z "$FFMPEG" ]]; then
  echo '{"error":"ffmpeg with libvmaf not found on ingest host; install via infra/zixi/scripts/install-ingest-vmaf.sh"}' >&2
  exit 1
fi

find_distorted() {
  local candidate=""
  if [[ -d "$RECORDING_DIR" ]]; then
    candidate="$(
      find "$RECORDING_DIR" -type f \( -name '*.ts' -o -name '*.mp4' -o -name '*.mkv' -o -name '*.m2ts' \) \
        -newermt "@${START_EPOCH}" ! -newermt "@$((END_EPOCH + 300))" -printf '%T@ %p\n' 2>/dev/null \
        | sort -nr | head -1 | cut -d' ' -f2-
    )"
    if [[ -z "$candidate" ]]; then
      candidate="$(
        find "$RECORDING_DIR" -type f \( -name '*.ts' -o -name '*.mp4' -o -name '*.mkv' -o -name '*.m2ts' \) \
          -newermt "@${START_EPOCH}" -printf '%T@ %p\n' 2>/dev/null \
          | sort -nr | head -1 | cut -d' ' -f2-
      )"
    fi
    if [[ -z "$candidate" ]]; then
      candidate="$(find "$RECORDING_DIR" -type f \( -name '*.ts' -o -name '*.mp4' -o -name '*.mkv' -o -name '*.m2ts' \) -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)"
    fi
  fi
  echo "$candidate"
}

DISTORTED="$(find_distorted)"
if [[ -z "$DISTORTED" || ! -f "$DISTORTED" ]]; then
  echo "{\"error\":\"no recording found in ${RECORDING_DIR} for benchmark window\"}" >&2
  exit 1
fi

LOG_PATH="${WORK_DIR}/vmaf-$(basename "$DISTORTED").json"
rm -f "$LOG_PATH"

set +e
"$FFMPEG" -hide_banner -loglevel error -y \
  -i "$DISTORTED" \
  -i "$REFERENCE" \
  -lavfi "libvmaf=log_fmt=json:log_path=${LOG_PATH}:n_threads=4" \
  -f null - 2>"${WORK_DIR}/vmaf-ffmpeg.err"
FFMPEG_CODE=$?
set -e

if [[ $FFMPEG_CODE -ne 0 || ! -f "$LOG_PATH" ]]; then
  ERR="$(tr '\n' ' ' < "${WORK_DIR}/vmaf-ffmpeg.err" | head -c 400)"
  echo "{\"error\":\"ffmpeg libvmaf failed\",\"distorted\":\"${DISTORTED}\",\"detail\":\"${ERR}\"}" >&2
  exit 1
fi

python3 - <<'PY' "$LOG_PATH" "$DISTORTED" "$REFERENCE"
import json
import sys

log_path, distorted, reference = sys.argv[1:4]
with open(log_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

score = payload.get("pooled_metrics", {}).get("vmaf")
if score is None:
    raise SystemExit('{"error":"vmaf score missing from libvmaf log"}')

print(json.dumps({
    "vmaf_score": round(float(score), 3),
    "distorted_path": distorted,
    "reference_path": reference,
    "log_path": log_path,
}))
PY
