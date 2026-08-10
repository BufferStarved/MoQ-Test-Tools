import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
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
});
