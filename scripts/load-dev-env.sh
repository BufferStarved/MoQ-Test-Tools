# Shared by scripts/dev.sh and scripts/start-api.sh.
# Load GCP East / Linode ingest stack IPs (so Destination pickers are not
# empty), then the repo .env so local overrides win.
set -euo pipefail

: "${ROOT_DIR:?ROOT_DIR must be set}"

load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$file"
  set +a
}

load_env_file "$ROOT_DIR/infra/web/scripts/gcp-east-stack.env.example"
load_env_file "$ROOT_DIR/infra/web/scripts/linode-stack.env.example"
load_env_file "$ROOT_DIR/.env"
