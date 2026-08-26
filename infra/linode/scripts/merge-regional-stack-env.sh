#!/usr/bin/env bash
# Merge Dallas / Fremont stack IPs into the orchestrator /etc/moq-web.env.
# Does not copy ingest-agent tokens. Empty ZIXI_IP keeps Zixi grey.
#
# Usage:
#   ./infra/linode/scripts/merge-regional-stack-env.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
WEB_IP="${WEB_IP:-34.9.217.178}"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=30)

ACTIVE="$(curl -fsS -m 20 "https://moq.sean-mccarthy.net/api/uploads" 2>/dev/null \
  | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: print(0); raise SystemExit
items=d if isinstance(d,list) else d.get("jobs",d.get("uploads",[]))
print(sum(1 for j in items if isinstance(j,dict) and j.get("status") in ("running","starting","pending")))' 2>/dev/null || echo 0)"
ACTIVE="$(printf '%s' "${ACTIVE:-0}" | head -n1 | tr -cd '0-9')"
ACTIVE="${ACTIVE:-0}"
if [[ "$ACTIVE" != "0" ]]; then
  echo "REFUSING: $ACTIVE job(s) in flight." >&2
  exit 3
fi

payload="$(
  ROOT_DIR="$ROOT_DIR" python3 - <<'PY'
import os
from pathlib import Path

root = Path(os.environ["ROOT_DIR"])
for name in (
    "infra/web/scripts/linode-central-stack.env.example",
    "infra/web/scripts/linode-west-stack.env.example",
):
    for line in (root / name).read_text().splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        if key.endswith("_INGEST_AGENT_TOKEN"):
            continue
        print(f"{key}={value}")
PY
)"

ssh "${SSH_OPTS[@]}" "$WEB_IP" "sudo bash -s" <<EOF
set -euo pipefail
ENV_FILE=/etc/moq-web.env
upsert() {
  local key="\$1" val="\$2"
  if grep -q "^\${key}=" "\$ENV_FILE"; then
    sed -i "s|^\${key}=.*|\${key}=\${val}|" "\$ENV_FILE"
  else
    printf '%s=%s\\n' "\$key" "\$val" >> "\$ENV_FILE"
  fi
}
while IFS= read -r line; do
  [[ -n "\$line" ]] || continue
  upsert "\${line%%=*}" "\${line#*=}"
done <<'KEYS'
${payload}
KEYS
systemctl restart moq-web
sleep 4
systemctl is-active moq-web
EOF

echo "Merged Dallas/Fremont MediaMTX + MoQ IPs into ${WEB_IP}:/etc/moq-web.env"
