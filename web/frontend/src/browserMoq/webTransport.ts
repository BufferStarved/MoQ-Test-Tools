import { moqtProtocolToken, type MoqtDraftVersion } from "./moqtVersions";

function wtOptions(
  certHash: ArrayBuffer | undefined,
  protocols: string[],
): Record<string, unknown> {
  const options: Record<string, unknown> = { protocols };
  if (certHash) {
    options.serverCertificateHashes = [{ algorithm: "sha-256", value: certHash }];
  }
  return options;
}

/**
 * Dial moqx with an explicit WT protocol. Never retry without `moqt-N`.
 *
 * Protocol-less fallback can still make WebTransport.ready — moqx accepts
 * the session — then never forwards tracks. The player logs tls_pin=ok
 * and then 0x10 (no such namespace).
 */
export async function openStrictMoqtWebTransport(
  url: string,
  certHash: ArrayBuffer | undefined,
  draft: MoqtDraftVersion,
): Promise<WebTransport> {
  const transport = new WebTransport(url, wtOptions(certHash, [moqtProtocolToken(draft)]));
  void transport.closed.catch(() => undefined);
  await transport.ready;
  return transport;
}

export function createStrictMoqtTransport(options: {
  certHash?: ArrayBuffer;
  draftVersion: MoqtDraftVersion;
}): (url: string) => Promise<WebTransport> {
  return (url) => openStrictMoqtWebTransport(url, options.certHash, options.draftVersion);
}
