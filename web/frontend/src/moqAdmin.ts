/** moqx Prometheus admin for a WebTransport relay URL.

Prod leftover is UDP 4433 + TCP 8000. Draft-18 canary is UDP 14433 + TCP 18000.
Scraping :8000 for a :14433 publish watches the other container.
*/

export const CANARY_WT_PORT = 14433;
export const CANARY_ADMIN_PORT = 18000;
export const DEFAULT_ADMIN_PORT = 8000;

export function adminPortForEndpoint(endpointUrl: string): number {
  try {
    const port = Number(new URL(endpointUrl).port);
    if (port === CANARY_WT_PORT) {
      return CANARY_ADMIN_PORT;
    }
  } catch {
    /* keep leftover admin */
  }
  return DEFAULT_ADMIN_PORT;
}

export function adminHostForEndpoint(endpointUrl: string): string {
  try {
    const host = new URL(endpointUrl).hostname;
    if (host.endsWith(".sslip.io")) {
      const dashed = host.split(".")[0] ?? "";
      const parts = dashed.split("-");
      if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
        return parts.join(".");
      }
    }
    return host;
  } catch {
    return "";
  }
}

export function adminBaseUrlForEndpoint(endpointUrl: string): string {
  const host = adminHostForEndpoint(endpointUrl);
  if (!host) {
    return "";
  }
  return `http://${host}:${adminPortForEndpoint(endpointUrl)}`;
}
