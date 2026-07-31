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

/** Shell recipe to connect a laptop publisher agent to this API.
 *
 * Must stay paste-safe for a default macOS zsh: no comments (interactive zsh
 * rejects `#` lines — parens in them become parse errors), no blank lines,
 * no backslash continuations.
 */
export function localPublisherAgentCommand(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
): string {
  const api = apiOrigin.replace(/\/$/, "");
  return `git clone ${GH_REPO}.git
cd MoQ-Test-Tools
LOCAL_PUBLISHER_API=${api} LOCAL_PUBLISHER_TOKEN=${token} ./scripts/run-local-publisher.sh`;
}

/** Shorter one-liner when the repo is already checked out. */
export function localPublisherAgentOneLiner(
  apiOrigin: string,
  token: string = DEFAULT_LOCAL_PUBLISHER_TOKEN,
): string {
  const api = apiOrigin.replace(/\/$/, "");
  return `LOCAL_PUBLISHER_API=${api} LOCAL_PUBLISHER_TOKEN=${token} ./scripts/run-local-publisher.sh`;
}
