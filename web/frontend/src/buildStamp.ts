/** Frontend git short SHA baked in at `vite build` (`VITE_GIT_SHA`). */
export function formatBuildStamp(sha: string | undefined): string {
  const trimmed = (sha ?? "").trim();
  return trimmed || "dev";
}

export function frontendBuildSha(): string {
  return formatBuildStamp(import.meta.env.VITE_GIT_SHA);
}
