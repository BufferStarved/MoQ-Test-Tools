import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // ws: true is required or Vite's dev proxy silently drops the upgrade
      // for /api/live/sessions/{id}/ws (live webcam bridge) — without it the
      // socket closes immediately client-side ("closed before the connection
      // is established") and the whole webcam comparison flow can never be
      // exercised against a local dev API, only prod. HTTP endpoints work
      // either way, so this is additive.
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
