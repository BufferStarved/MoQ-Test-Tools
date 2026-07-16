import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

/** Known relay leaf cert SHA-256 fingerprints (hex, no colons). */
const DEFAULT_CERT_SHA256 = {
  '34-28-164-90.sslip.io': '7115b12274dcf092c3e77d763111f0a2088a0f2029efc8e1f223a9584b1f5b54',
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
 * moqx serves QUIC only on UDP :4433 — openssl s_client over TCP often fails.
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
