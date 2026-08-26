import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function resolveGitSha(command: string): string {
  const fromEnv = (process.env.VITE_GIT_SHA || "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  let sha = "dev";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || "dev";
  } catch {
    sha = "dev";
  }
  // `vite` / `npm run dev` is the local environment. Production builds bake
  // VITE_GIT_SHA from the deploy script (short HEAD, no suffix).
  if (command === "serve" && sha !== "dev" && !sha.endsWith("-dev")) {
    return `${sha}-dev`;
  }
  return sha;
}

export default defineConfig(({ command }) => {
  const gitSha = resolveGitSha(command);
  process.env.VITE_GIT_SHA = gitSha;
  return {
  define: {
    "import.meta.env.VITE_GIT_SHA": JSON.stringify(gitSha),
  },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // ws: true is required or Vite's dev proxy silently drops the upgrade
      // for /api/publisher-agent/ws (local publisher agent connection) —
      // without it the socket closes immediately client-side ("closed before
      // the connection is established") and the local publisher agent can
      // never connect to a local dev API, only prod. HTTP endpoints work
      // either way, so this is additive.
      "/api": {
        // Override with VITE_API_PROXY=https://moq.sean-mccarthy.net to validate
        // a local frontend against prod encodes without deploying the UI.
        target: process.env.VITE_API_PROXY || "http://127.0.0.1:8000",
        changeOrigin: true,
        ws: true,
        secure: true,
      },
    },
  },
  };
});
