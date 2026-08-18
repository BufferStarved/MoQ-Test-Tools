import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

/**
 * Known relay leaf cert SHA-256 fingerprints (hex, no colons).
 * Keep in sync with src/moq_relay_certs.py — openssl TCP to :4433 usually
 * fails because moqx is QUIC-only on that port.
 */
const DEFAULT_CERT_SHA256 = {
  '34-28-164-90.sslip.io': '3cfec20ab9f6905b1765037d0a37e198cc9e07245f008570f11d566e853f1cf6',
  '34-138-137-211.sslip.io': '13e87aa62f8996119ade0612fbae33426598d50c5125847d301a9d13ac269c9a',
  '45-79-177-85.sslip.io': 'abc0b4b2b484449bb91d8a9a2c76d1f4cf382a631fb158266f67b23459168bc6',
};

function hexToUint8Array(hex) {
  const normalized = hex.replace(/:/g, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid certificate SHA-256 fingerprint: ${hex}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Resolve relay TLS certificate SHA-256 for WebTransport pinning.
 * A non-empty MOQ_RELAY_CERT_SHA256 env overrides the hostname map — only
 * set it for a single-relay worker, never as a stale catch-all.
 */
export function resolveCertSha256(hostname, port) {
  const envHex = process.env.MOQ_RELAY_CERT_SHA256?.trim();
  if (envHex) {
    return hexToUint8Array(envHex);
  }

  const hostKey = hostname.trim().toLowerCase();
  const mapped = DEFAULT_CERT_SHA256[hostKey];
  if (mapped) {
    return hexToUint8Array(mapped);
  }

  return fetchCertSha256(hostname, port);
}

/**
 * Fetch the relay TLS certificate SHA-256 via openssl (TCP TLS probes only).
 */
export function fetchCertSha256(hostname, port) {
  const der = execSync(
    `echo | openssl s_client -connect ${hostname}:${port} -servername ${hostname} 2>/dev/null | openssl x509 -outform DER`,
    { encoding: 'buffer', maxBuffer: 16 * 1024, timeout: 15_000 },
  );
  const digest = createHash('sha256').update(der).digest();
  const out = new Uint8Array(digest.length);
  out.set(digest);
  return out;
}
