export const GH_REPO = "https://github.com/BufferStarved/MoQ-Test-Tools";
export const GH_LOCAL_PUBLISHER_DOC = `${GH_REPO}/blob/main/docs/LOCAL-PUBLISHER.md`;
export const GH_BYO_ENCODER_DOC = `${GH_REPO}/blob/main/docs/BYO-ENCODER.md`;

/** Hosted demo token (see infra/web/scripts/install-web-app.sh). */
export const DEFAULT_LOCAL_PUBLISHER_TOKEN = "dev-local-publisher";

export function isLocalDevApi(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function apiBase(apiOrigin: string): string {
  return apiOrigin.replace(/\/$/, "");
}

/**
 * One laptop helper for this site: MoQ draft-18 plus SRT / RTMP / WebRTC.
 * Do not run a second `main` helper — two agents fight over the camera
 * and can split one comparison across processes.
 */
export function localPublisherAgentCommand(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
): string {
  const api = apiBase(apiOrigin);
  return `git clone --branch feat/moq-draft-18 --single-branch ${GH_REPO}.git MoQ-Test-Tools-d18 2>/dev/null || git -C MoQ-Test-Tools-d18 pull --ff-only
cd MoQ-Test-Tools-d18
./scripts/install-moq5.sh
LOCAL_PUBLISHER_API=${api} LOCAL_PUBLISHER_TOKEN=${token} ./scripts/run-local-publisher.sh`;
}

/** @deprecated Use {@link localPublisherAgentCommand} — one helper covers d18 + SRT/RTMP/WebRTC. */
export function localPublisherAgentD18Command(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
): string {
  return localPublisherAgentCommand(apiOrigin, token);
}

/** Shorter one-liner when the repo is already checked out. */
export function localPublisherAgentOneLiner(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
): string {
  const api = apiBase(apiOrigin);
  return `LOCAL_PUBLISHER_API=${api} LOCAL_PUBLISHER_TOKEN=${token} ./scripts/run-local-publisher.sh`;
}
