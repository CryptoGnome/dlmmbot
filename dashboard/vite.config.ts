import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    proxy: {
      "/api": {
        // DASH_PROXY lets `npm run dev` render against a remote instance
        // (e.g. the Railway dashboard) instead of a local :8787 — handy for
        // eyeballing chart changes on real data without a local bot.
        target: process.env.DASH_PROXY ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        secure: true,
        // With DASH_PROXY_TOKEN set, the proxy authenticates for you so the
        // dev page never needs ?token= — the token stays in your shell.
        headers: process.env.DASH_PROXY_TOKEN
          ? { Authorization: `Bearer ${process.env.DASH_PROXY_TOKEN}` }
          : undefined,
      },
      // The live book streams over a WebSocket, not /api — without this the
      // dev page renders every panel empty against a remote instance.
      "/ws": {
        target: process.env.DASH_PROXY ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        secure: true,
        ws: true,
      },
    },
  },
});
