#!/usr/bin/env bash
# Post-VM checklist after Zixi Broadcaster installer has been run.
set -euo pipefail

HOST="${1:-}"
if [[ -z "$HOST" ]]; then
  echo "Usage: $0 <vm-public-ip>"
  exit 1
fi

PORTS=(4444 1935 7777 2088 2077)
SRT_PORT="${SRT_PORT:-2088}"

echo "Checking Zixi host at $HOST ..."
echo ""

for port in "${PORTS[@]}"; do
  if nc -z -w 3 "$HOST" "$port" 2>/dev/null; then
    echo "  TCP $port  open"
  else
    echo "  TCP $port  closed (may be normal before Zixi install)"
  fi
done

if nc -z -u -w 3 "$HOST" "$SRT_PORT" 2>/dev/null; then
  echo "  UDP $SRT_PORT  reachable"
else
  echo "  UDP $SRT_PORT  not confirmed (UDP checks are unreliable; verify in Zixi UI)"
fi

echo ""
echo "After Zixi is installed:"
echo "  Web UI:  http://${HOST}:4444"
echo "  SRT URL: srt://${HOST}:${SRT_PORT}?mode=caller&latency=200000"
echo ""
echo "Configure in Zixi:"
echo "  - Input type: SRT (push / listener)"
echo "  - Listening port: ${SRT_PORT}"
echo "  - Allow outbound HTTPS to license.zixi.com (ports 80/443)"
