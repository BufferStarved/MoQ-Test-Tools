"""WebTransport certificate pins for OpenMOQ relays.

Keep in sync with tools/openmoq-recorder/cert.mjs and web/api fingerprint serving.
Hashes are SHA-256 of the leaf DER cert (hex, no colons) — required because
moqx speaks QUIC on UDP :4433 and browsers cannot fetch /fingerprint over TCP.
"""

from __future__ import annotations

from typing import Optional
from urllib.parse import urlparse

# Rotated with infra/moqx/scripts/configure-webtransport-cert.sh (14-day pins).
MOQ_RELAY_CERT_SHA256: dict[str, str] = {
    # us-central1 — rotated 2026-08-10; renew before Aug 24
    "34-28-164-90.sslip.io": "3cfec20ab9f6905b1765037d0a37e198cc9e07245f008570f11d566e853f1cf6",
    # us-east1 — rotated 2026-08-14
    "34-138-137-211.sslip.io": "13e87aa62f8996119ade0612fbae33426598d50c5125847d301a9d13ac269c9a",
    # Linode us-east — rotated 2026-08-14
    "45-79-177-85.sslip.io": "abc0b4b2b484449bb91d8a9a2c76d1f4cf382a631fb158266f67b23459168bc6",
}


def fingerprint_for_host(host: str) -> Optional[str]:
    key = (host or "").strip().lower()
    if not key:
        return None
    return MOQ_RELAY_CERT_SHA256.get(key)


def fingerprint_for_relay_url(relay_url: str) -> Optional[str]:
    """Pin only leftover :4433 (≤14-day self-signed). Public :14433 is LE.

    Applying the :4433 hostname map to :14433 is the ingest-VMAF handshake
    failure (openmoq-record vs Let's Encrypt).
    """
    parsed = urlparse((relay_url or "").strip())
    if parsed.port == 14433 or ":14433" in (relay_url or ""):
        return None
    return fingerprint_for_host(parsed.hostname or "")
