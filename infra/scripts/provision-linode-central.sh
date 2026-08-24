#!/usr/bin/env bash
# Thin wrapper — Dallas (us-central). See provision-linode-region.sh.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/provision-linode-region.sh" us-central "$@"
