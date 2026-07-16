#!/usr/bin/env bash
# The moqx relay VM runs moqx only. Ingest VMAF + MoQ recording live on the
# shared GCP ingest worker (see infra/zixi/scripts/install-ingest-agent.sh).
set -euo pipefail

cat <<'EOF'
MoQ relay ingest VMAF is not installed on the relay VM.

Use the GCP ingest worker instead:
  infra/zixi/scripts/install-ingest-agent.sh
  infra/zixi/scripts/install-ingest-vmaf.sh
  infra/zixi/scripts/install-moq5-recorder.sh

The moq_gcp_relay preset points ingest_agent_url at the worker while uploads
still publish to this relay.
EOF
exit 1
