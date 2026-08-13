#!/usr/bin/env node
/**
 * LAN ops dashboard — static SPA + read-only JSON API + live WebSocket.
 *   DASH_TOKEN=… node deploy/dashboard-server.mjs
 *   http://HOST:8787/?token=…
 *   ws://HOST:8787/ws?token=…
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { buildLiveBookSnapshot } from "./lib/live-book-snapshot.mjs";
import { buildHistorySnapshot } from "./lib/history-snapshot.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.FARMER_ROOT ?? resolve(__dir, ".."));

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
const WATCH_MS = Number(process.env.DASH_WS_WATCH_MS ?? 3_000);
const HIST_MS = Number(process.env.DASH_WS_HIST_MS ?? 30_000);

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

function allowRange(range) {
  return range === "7d" || range === "30d" || range === "all" ? range : "30d";
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

  const needsAuth = url.pathname.startsWith("/api/");
  if (needsAuth && !authorized(req, url)) {
    sendJson(res, 401, { error: "unauthorized — set ?token= or Authorization: Bearer" });
    return;
  }

  if (url.pathname === "/api/watch") {
    try {
      sendJson(res, 200, buildLiveBookSnapshot(root));
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/history") {
    const allowed = allowRange(url.searchParams.get("range") ?? "30d");
    try {
      sendJson(res, 200, buildHistorySnapshot(root, allowed));
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, ts: Date.now(), ws: true });
    return;
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  rel = rel.replace(/\.\./g, "");
  const file = join(dist, rel);
  if (existsSync(file) && statSync(file).isFile()) {
    sendFile(res, file);
    return;
  }
  const index = join(dist, "index.html");
  if (existsSync(index)) {
    sendFile(res, index);
    return;
  }
  res.writeHead(503, { "Content-Type": "text/plain" });
  res.end("dashboard/dist missing — run: cd dashboard && npm ci && npm run build");
});

/** @type {Map<import('ws').WebSocket, { range: string }>} */
const clients = new Map();

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!authorized(req, url)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function pushWatch(ws) {
  try {
    send(ws, { type: "watch", data: buildLiveBookSnapshot(root) });
  } catch (e) {
    send(ws, { type: "error", error: e.message ?? String(e) });
  }
}

function pushHistory(ws, range) {
  const allowed = allowRange(range);
  try {
    send(ws, { type: "history", range: allowed, data: buildHistorySnapshot(root, allowed) });
  } catch (e) {
    send(ws, { type: "error", error: e.message ?? String(e) });
  }
}

wss.on("connection", (ws) => {
  clients.set(ws, { range: "30d" });
  send(ws, { type: "hello", watchMs: WATCH_MS, histMs: HIST_MS });
  pushWatch(ws);
  pushHistory(ws, "30d");

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg?.type === "range" && typeof msg.range === "string") {
      const range = allowRange(msg.range);
      clients.set(ws, { range });
      pushHistory(ws, range);
    } else if (msg?.type === "ping") {
      send(ws, { type: "pong", ts: Date.now() });
    }
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

setInterval(() => {
  if (clients.size === 0) return;
  let payload;
  try {
    payload = JSON.stringify({ type: "watch", data: buildLiveBookSnapshot(root) });
  } catch (e) {
    payload = JSON.stringify({ type: "error", error: e.message ?? String(e) });
  }
  for (const ws of clients.keys()) {
    if (ws.readyState === 1) ws.send(payload);
  }
}, WATCH_MS);

setInterval(() => {
  if (clients.size === 0) return;
  /** @type {Map<string, string>} */
  const byRange = new Map();
  for (const [, st] of clients) {
    if (!byRange.has(st.range)) {
      try {
        byRange.set(st.range, JSON.stringify({
          type: "history",
          range: st.range,
          data: buildHistorySnapshot(root, st.range),
        }));
      } catch (e) {
        byRange.set(st.range, JSON.stringify({ type: "error", error: e.message ?? String(e) }));
      }
    }
  }
  for (const [ws, st] of clients) {
    const payload = byRange.get(st.range);
    if (payload && ws.readyState === 1) ws.send(payload);
  }
}, HIST_MS);

if (!token) {
  console.error("[dash] FATAL: DASH_TOKEN env is required");
  process.exit(1);
}

server.listen(port, "0.0.0.0", () => {
  console.log(`[dash] listening on http://0.0.0.0:${port} (root=${root}, ws=/ws every ${WATCH_MS}ms)`);
});
