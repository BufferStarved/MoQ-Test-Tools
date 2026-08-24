export const GH_REPO = "https://github.com/BufferStarved/MoQ-Test-Tools";
export const GH_LOCAL_PUBLISHER_DOC = `${GH_REPO}/blob/main/docs/LOCAL-PUBLISHER.md`;
export const GH_BYO_ENCODER_DOC = `${GH_REPO}/blob/main/docs/BYO-ENCODER.md`;

/** Dev-only token. Never ship this as the hosted-site publisher token. */
export const DEFAULT_LOCAL_PUBLISHER_TOKEN = "dev-local-publisher";

const PUBLIC_ORCHESTRATOR_HOSTS = new Set([
  "moq.sean-mccarthy.net",
  "sean-mccarthy.net",
  "www.sean-mccarthy.net",
  "34.9.217.178",
]);

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLocalDevApi(origin: string): boolean {
  const host = hostnameOf(origin);
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function isPublicOrchestrator(origin: string): boolean {
  const host = hostnameOf(origin);
  if (!host) {
    return false;
  }
  if (PUBLIC_ORCHESTRATOR_HOSTS.has(host)) {
    return true;
  }
  return host.endsWith(".sean-mccarthy.net");
}

/** Shared-token helper (no session) is localhost-only. */
export function laptopLastMileAllowed(origin: string): boolean {
  return isLocalDevApi(origin) && !isPublicOrchestrator(origin);
}

function apiBase(apiOrigin: string): string {
  return apiOrigin.replace(/\/$/, "");
}

/**
 * Helper command for this browser. Public hosts require a session so ffmpeg
 * opens this visitor's camera, not a shared operator laptop.
 */
export function localPublisherAgentCommand(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
  session = "",
): string {
  return localPublisherAgentOneLiner(apiOrigin, token, session);
}

/** @deprecated Use {@link localPublisherAgentCommand}. */
export function localPublisherAgentD18Command(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
  session = "",
): string {
  return localPublisherAgentCommand(apiOrigin, token, session);
}

export function localPublisherAgentOneLiner(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
  session = "",
): string {
  const api = apiBase(apiOrigin);
  if (isPublicOrchestrator(apiOrigin) || !isLocalDevApi(apiOrigin)) {
    if (!session.trim()) {
      return "";
    }
    return `LOCAL_PUBLISHER_API=${api} LOCAL_PUBLISHER_SESSION=${session.trim()} ./scripts/run-local-publisher.sh`;
  }
  return `LOCAL_PUBLISHER_API=${api} LOCAL_PUBLISHER_TOKEN=${token} ./scripts/run-local-publisher.sh`;
}
