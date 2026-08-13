#!/usr/bin/env node
/**
 * LAN ops dashboard — static SPA + read-only JSON API.
 *   DASH_TOKEN=… node deploy/dashboard-server.mjs
 *   http://HOST:8787/?token=…
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLiveBookSnapshot } from "./lib/live-book-snapshot.mjs";
import { buildHistorySnapshot } from "./lib/history-snapshot.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.FARMER_ROOT ?? resolve(__dir, ".."));

// Minimal .env load (same pattern as src/config.ts) — process.env wins.
try {
  for (const line of readFileSync(resolve(root, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, value] = m;
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
} catch { /* no .env */ }

const dist = resolve(root, "dashboard/dist");
const port = Number(process.env.DASH_PORT ?? 8787);
const token = process.env.DASH_TOKEN ?? "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function authorized(req, url) {
  if (!token) return false;
  const q = url.searchParams.get("token");
  if (q && q === token) return true;
  const h = req.headers.authorization ?? "";
  if (h === `Bearer ${token}`) return true;
  return false;
}

function sendJson(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(raw);
}

function sendFile(res, path) {
  try {
    const data = readFileSync(path);
    const type = MIME[extname(path)] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404).end("not found");
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end();
    return;
  }

  if (!authorized(req, url)) {
    if (url.pathname.startsWith("/api/")) {
      sendJson(res, 401, { error: "unauthorized — set ?token= or Authorization: Bearer" });
      return;
    }
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("unauthorized — open with ?token=YOUR_DASH_TOKEN");
    return;
  }

  if (url.pathname === "/api/watch") {
    try {
      sendJson(res, 200, buildLiveBookSnapshot(root));
    } catch (e) {
      sendJson(res, 500, { error: (e).message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/history") {
    const range = url.searchParams.get("range") ?? "30d";
    const allowed = range === "7d" || range === "30d" || range === "all" ? range : "30d";
    try {
      sendJson(res, 200, buildHistorySnapshot(root, allowed));
    } catch (e) {
      sendJson(res, 500, { error: (e).message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, ts: Date.now() });
    return;
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  rel = rel.replace(/\.\./g, "");
  const file = join(dist, rel);
  if (existsSync(file) && statSync(file).isFile()) {
    sendFile(res, file);
    return;
  }
  // SPA fallback
  const index = join(dist, "index.html");
  if (existsSync(index)) {
    sendFile(res, index);
    return;
  }
  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end("dashboard/dist missing — run: cd dashboard && npm ci && npm run build");
});

if (!token) {
  console.error("[dash] FATAL: DASH_TOKEN env is required");
  process.exit(1);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`[dash] listening on http://0.0.0.0:${port} (root=${root})`);
});
