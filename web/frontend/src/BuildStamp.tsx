import { frontendBuildSha } from "./buildStamp";

/** Always-visible production revision so a cached SPA is obvious. */
export function BuildStamp() {
  const sha = frontendBuildSha();
  return (
    <p className="build-stamp" title="Frontend git revision from the last production build">
      {sha}
    </p>
  );
}
