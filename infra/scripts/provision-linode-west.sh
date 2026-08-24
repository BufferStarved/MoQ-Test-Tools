#!/usr/bin/env bash
# Thin wrapper — Fremont (us-west). See provision-linode-region.sh.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/provision-linode-region.sh" us-west "$@"
