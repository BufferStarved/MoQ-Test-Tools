#!/usr/bin/env bash
# Print the sslip.io hostname for a public IPv4 address.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <ipv4>" >&2
  exit 1
fi

IP="$1"
if [[ ! "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Expected IPv4 address, got: $IP" >&2
  exit 1
fi

echo "${IP//./-}.sslip.io"
