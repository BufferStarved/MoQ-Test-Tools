#!/usr/bin/env bash
# Patch app presets with the deployed MoQ relay hostname.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

if [[ $# -lt 1 ]]; then
  TF_DIR="$ROOT_DIR/terraform/gcp"
  if [[ -d "$TF_DIR" ]] && command -v terraform >/dev/null 2>&1; then
    RELAY_IP="$(terraform -chdir="$TF_DIR" output -raw public_ip 2>/dev/null || true)"
    RELAY_DOMAIN="$(terraform -chdir="$TF_DIR" output -raw relay_domain 2>/dev/null || true)"
  fi
  if [[ -z "${RELAY_IP:-}" ]]; then
    echo "Usage: $0 <relay-public-ip>" >&2
    exit 1
  fi
else
  RELAY_IP="$1"
  RELAY_DOMAIN="$("$ROOT_DIR/scripts/sslip-domain.sh" "$RELAY_IP")"
fi

RELAY_BASE_URL="https://${RELAY_DOMAIN}:4433"
RELAY_PUBLISH_URL="${RELAY_BASE_URL}/moq-relay"
FINGERPRINT_URL="${RELAY_BASE_URL}/fingerprint"

DESTINATIONS="$REPO_ROOT/src/destinations.py"

python3 - <<PY
from pathlib import Path
import re

path = Path("$DESTINATIONS")
text = path.read_text()

relay_base = "$RELAY_BASE_URL"
relay_publish = "$RELAY_PUBLISH_URL"

pattern = re.compile(
    r'(ServicePreset\(\s*id="moq_gcp_relay".*?url=")[^"]*(")',
    re.S,
)
replacement = rf'\1{relay_publish}\2'
new_text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit("Could not update moq_gcp_relay preset URL in destinations.py")

notes_pattern = re.compile(
    r'(id="moq_gcp_relay".*?notes=\()\s*(\([^)]*\))\s*(\))',
    re.S,
)
notes = (
    f'(\n            "Managed OpenMOQ moqx relay on GCP ({relay_base}). "\n'
    f'            "Playback namespace: benchmark. Fingerprint: {relay_base}/fingerprint. "\n'
    f'            "Upload requires OpenMOQ ffmpeg muxer (roadmap)."\n        )'
)
new_text, count = notes_pattern.subn(rf"\1{notes}\3", new_text, count=1)
if count != 1:
    raise SystemExit("Could not update moq_gcp_relay notes in destinations.py")

path.write_text(new_text)
print(f"Updated {path}")
print(f"  relay publish URL: {relay_publish}")
PY
