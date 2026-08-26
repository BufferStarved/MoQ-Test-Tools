import { frontendBuildSha } from "./buildStamp";

/** Always-visible production revision so a cached SPA is obvious. */
export function BuildStamp() {
  const sha = frontendBuildSha();
  return (
    <p
      className="build-stamp"
      title={
        sha.endsWith("-dev")
          ? "Local dev build (SHA-dev). Prod is the same SHA with no suffix."
          : "Production build — short git SHA, no suffix."
      }
    >
      {sha}
    </p>
  );
}
