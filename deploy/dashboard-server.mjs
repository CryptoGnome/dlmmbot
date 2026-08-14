#!/usr/bin/env node
/**
 * LAN ops dashboard — static SPA + JSON API + live WebSocket.
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
import { applyConfigUpdates, applyEnvUpdates, flattenConfig, parseConfig, readEnvMasked } from "./lib/config-edit.mjs";
import {
  generateAndEncrypt, importAndEncrypt, unlockEncryptedWallet,
  setupStatus, writeSetupState, hasEncryptedWallet,
} from "./lib/wallet-crypto.mjs";
import { applyRuntimeEnv } from "./lib/runtime-paths.mjs";
import {
  approveDeploy, readDeployPrefs, writeDeployPrefs,
} from "./lib/deploy-prefs.mjs";
import { insertError, dismissErrors } from "./lib/error-log.mjs";
import {
  listProfiles, listCommunityProfiles, saveLocalProfile, deleteLocalProfile,
  resolveProfileUpdates, previewProfileDiff, applyProfileUpdates, githubProposeUrl,
  snapshotAllowlistedConfig,
} from "./lib/profiles.mjs";
import { requestHalt, clearHalt, readHaltState } from "./lib/halt.mjs";
import { requestPause, clearPause, readPauseState } from "./lib/pause.mjs";
import { execSync } from "node:child_process";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.FARMER_ROOT ?? resolve(__dir, ".."));
applyRuntimeEnv(root);

try {
  const envFiles = [resolve(root, ".env"), process.env.FARMER_ENV_PATH].filter(Boolean);
  for (const file of envFiles) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) continue;
      const [, key, value] = m;
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
} catch { /* no .env */ }

const dist = resolve(root, "dashboard/dist");
const port = Number(process.env.PORT ?? process.env.DASH_PORT ?? 8787);
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

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
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

/** Watch snapshot is ~4s; cache so WS ticks + /api/* don't serialize behind rebuilds. */
let watchCache = { at: 0, data: null, building: null };
const WATCH_CACHE_MS = Math.max(1_000, Math.floor(WATCH_MS * 0.9));

async function getWatchSnapshot() {
  const now = Date.now();
  if (watchCache.data && now - watchCache.at < WATCH_CACHE_MS) return watchCache.data;
  if (watchCache.building) return watchCache.building;
  watchCache.building = Promise.resolve().then(() => {
    const data = buildLiveBookSnapshot(root);
    watchCache = { at: Date.now(), data, building: null };
    return data;
  }).catch((e) => {
    watchCache.building = null;
    throw e;
  });
  return watchCache.building;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, PATCH, POST, OPTIONS",
    });
    res.end();
    return;
  }

  // Unauthenticated probe for Railway / load balancers
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const needsAuth = url.pathname.startsWith("/api/");
  if (needsAuth && !authorized(req, url)) {
    sendJson(res, 401, { error: "unauthorized — set ?token= or Authorization: Bearer" });
    return;
  }

  if (url.pathname === "/api/watch") {
    try {
      sendJson(res, 200, await getWatchSnapshot());
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

  if (url.pathname === "/api/config" && req.method === "GET") {
    try {
      sendJson(res, 200, { config: flattenConfig(parseConfig(root)) });
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/config" && req.method === "PATCH") {
    try {
      const body = await readBody(req);
      const updates = body?.updates ?? body;
      const result = applyConfigUpdates(root, updates);
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/profiles" && req.method === "GET") {
    try {
      sendJson(res, 200, listProfiles(root));
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/profiles/community" && req.method === "GET") {
    try {
      sendJson(res, 200, await listCommunityProfiles());
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/profiles/snapshot" && req.method === "GET") {
    try {
      const updates = snapshotAllowlistedConfig(root);
      sendJson(res, 200, { updates, share_url: githubProposeUrl("my-profile") });
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/profiles/local" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const profile = saveLocalProfile(root, {
        name: body?.name,
        description: body?.description,
        author: body?.author,
        tags: body?.tags,
        id: body?.id,
      });
      sendJson(res, 200, { ok: true, profile });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname.startsWith("/api/profiles/local/") && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(url.pathname.slice("/api/profiles/local/".length));
      sendJson(res, 200, deleteLocalProfile(root, id));
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/profiles/preview" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const resolved = await resolveProfileUpdates(root, body);
      const preview = previewProfileDiff(root, resolved.updates);
      sendJson(res, 200, {
        ok: true,
        profile: resolved.profile,
        updates: resolved.updates,
        dropped: resolved.dropped,
        changes: preview.changes,
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/profiles/apply" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const resolved = await resolveProfileUpdates(root, body);
      const result = applyProfileUpdates(root, resolved.updates);
      watchCache = { at: 0, data: null, building: null };
      sendJson(res, 200, {
        ok: true,
        applied: result.applied,
        dropped: result.dropped,
        profile: resolved.profile
          ? { id: resolved.profile.id, name: resolved.profile.name, source: resolved.profile.source }
          : null,
        config: result.config,
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/env" && req.method === "GET") {
    try {
      sendJson(res, 200, { env: readEnvMasked(root) });
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/secrets" && req.method === "PATCH") {
    try {
      const body = await readBody(req);
      const confirm = typeof body?.confirm === "string" ? body.confirm : "";
      if (!token || confirm !== token) {
        sendJson(res, 403, { error: "re-enter dash token to edit secrets" });
        return;
      }
      const updates = body?.updates ?? {};
      const result = applyEnvUpdates(root, updates);
      sendJson(res, 200, {
        ...result,
        note: "Wrote .env. Restart the bot (and dash if RPC/token changed) for full effect.",
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/secrets/unlock" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const confirm = typeof body?.confirm === "string" ? body.confirm : "";
      if (!token || confirm !== token) {
        sendJson(res, 403, { error: "wrong dash token" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        keys: [
          "RPC_URL", "RPC_URL_FALLBACK", "WALLET_PUBKEY", "PUBLIC_WALLET",
          "WALLET_PRIVATE_KEY", "WALLET_KEYPAIR_PATH",
          "JUPITER_API_KEY", "GMGN_API_KEY",
          "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
        ],
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/setup/status" && req.method === "GET") {
    try {
      sendJson(res, 200, setupStatus(readEnvMasked(root)));
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/setup/complete" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const state = writeSetupState({
        completed: body?.skipped ? false : true,
        skipped: !!body?.skipped,
        completedAt: new Date().toISOString(),
      });
      sendJson(res, 200, { ok: true, setup: state, ...setupStatus(readEnvMasked(root)) });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/wallet/generate" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const confirm = typeof body?.confirm === "string" ? body.confirm : "";
      if (!token || confirm !== token) {
        sendJson(res, 403, { error: "re-enter dash token" });
        return;
      }
      const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
      const overwrite = !!body?.overwrite;
      const result = generateAndEncrypt(passphrase, { overwrite });
      applyEnvUpdates(root, {
        PUBLIC_WALLET: result.publicKey,
        WALLET_PUBKEY: result.publicKey,
      });
      sendJson(res, 200, {
        publicKey: result.publicKey,
        secretOnce: result.secretOnce,
        note: "Encrypted wallet saved. Copy secretOnce now — it is not shown again. Unlock to enable live trading.",
        status: setupStatus(readEnvMasked(root)),
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/wallet/import" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const confirm = typeof body?.confirm === "string" ? body.confirm : "";
      if (!token || confirm !== token) {
        sendJson(res, 403, { error: "re-enter dash token" });
        return;
      }
      const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
      const secret = typeof body?.secret === "string" ? body.secret : "";
      const overwrite = !!body?.overwrite;
      const result = importAndEncrypt(secret, passphrase, { overwrite });
      applyEnvUpdates(root, {
        PUBLIC_WALLET: result.publicKey,
        WALLET_PUBKEY: result.publicKey,
      });
      sendJson(res, 200, {
        publicKey: result.publicKey,
        note: "Imported & encrypted. Unlock with your passphrase when you want the bot to trade.",
        status: setupStatus(readEnvMasked(root)),
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/deploy-prefs" && req.method === "GET") {
    try {
      sendJson(res, 200, { prefs: readDeployPrefs(root) });
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/deploy-prefs" && req.method === "PATCH") {
    try {
      const body = await readBody(req);
      const next = {};
      if (body?.autoUpdate != null) next.autoUpdate = !!body.autoUpdate;
      if (body?.autoUpdate === true) {
        next.approveSha = null;
        next.approvedAt = null;
      }
      const prefs = writeDeployPrefs(root, next);
      watchCache = { at: 0, data: null, building: null };
      sendJson(res, 200, { prefs });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/deploy-approve" && req.method === "POST") {
    try {
      const branch = process.env.DEPLOY_BRANCH || "master";
      let remoteSha = null;
      try {
        remoteSha = execSync(`git rev-parse refs/remotes/origin/${branch}`, {
          cwd: root, encoding: "utf8",
        }).trim() || null;
      } catch { /* */ }
      if (!remoteSha) {
        sendJson(res, 400, { error: "no origin tip to approve — is git fetch working?" });
        return;
      }
      const prefs = approveDeploy(root, remoteSha);
      watchCache = { at: 0, data: null, building: null };
      sendJson(res, 200, {
        ok: true,
        prefs,
        note: "Approved — meteora-deploy will pull within a minute if the watcher is running.",
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/wallet/unlock" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const confirm = typeof body?.confirm === "string" ? body.confirm : "";
      if (!token || confirm !== token) {
        sendJson(res, 403, { error: "re-enter dash token" });
        return;
      }
      if (!hasEncryptedWallet()) {
        sendJson(res, 400, { error: "no encrypted wallet — create or import first" });
        return;
      }
      const passphrase = typeof body?.passphrase === "string" ? body.passphrase : "";
      const unlocked = unlockEncryptedWallet(passphrase);
      applyEnvUpdates(root, {
        WALLET_PRIVATE_KEY: unlocked.secret,
        PUBLIC_WALLET: unlocked.publicKey,
        WALLET_PUBKEY: unlocked.publicKey,
      });
      sendJson(res, 200, {
        ok: true,
        publicKey: unlocked.publicKey,
        note: "Wallet unlocked into .env for the bot. Restart/redeploy to pick up the live key.",
        status: setupStatus(readEnvMasked(root)),
      });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/halt" && req.method === "GET") {
    try {
      sendJson(res, 200, { ...readHaltState(root), ...readPauseState(root) });
    } catch (e) {
      sendJson(res, 500, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/halt" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const confirm = typeof body?.confirm === "string" ? body.confirm : "";
      if (!token || confirm !== token) {
        sendJson(res, 403, { error: "re-enter dash token to halt/resume" });
        return;
      }
      const action = body?.action === "resume" ? "resume" : "halt";
      const state = action === "resume" ? clearHalt(root) : requestHalt(root);
      watchCache = { at: 0, data: null, building: null };
      sendJson(res, 200, { ok: true, ...state, ...readPauseState(root) });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/engine" && req.method === "POST") {
    try {
      // Soft ON/OFF — already authenticated via dash token query/header.
      if (!token) {
        sendJson(res, 401, { error: "dash token required" });
        return;
      }
      const body = await readBody(req);
      const action = body?.action === "off" ? "off" : "on";
      const pause = action === "off" ? requestPause(root) : clearPause(root);
      watchCache = { at: 0, data: null, building: null };
      sendJson(res, 200, { ok: true, ...pause, ...readHaltState(root) });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/errors/dismiss" && req.method === "POST") {
    try {
      if (!token) {
        sendJson(res, 401, { error: "dash token required" });
        return;
      }
      const body = await readBody(req);
      const all = body?.all === true;
      const ids = Array.isArray(body?.ids)
        ? body.ids.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      if (!all && !ids.length) {
        sendJson(res, 400, { error: "pass { all: true } or { ids: number[] }" });
        return;
      }
      const dismissed = dismissErrors(root, all ? { all: true } : { ids });
      watchCache = { at: 0, data: null, building: null };
      sendJson(res, 200, { ok: true, dismissed });
    } catch (e) {
      sendJson(res, 400, { error: e.message ?? String(e) });
    }
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, ts: Date.now(), ws: true });
    return;
  }

  // fallthrough: log unexpected API 404s lightly
  if (url.pathname.startsWith("/api/")) {
    insertError(root, {
      source: "dash",
      level: "warn",
      code: "api_not_found",
      message: `${req.method} ${url.pathname}`,
      dedupeSec: 300,
    });
    sendJson(res, 404, { error: "not found" });
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
let watchPushBusy = false;

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
  getWatchSnapshot()
    .then((data) => {
      send(ws, { type: "watch", data });
      if (data?.recent_errors) {
        send(ws, {
          type: "errors",
          data: data.recent_errors,
          stats: data.error_stats ?? null,
        });
      }
    })
    .catch((e) => {
      insertError(root, {
        source: "dash",
        code: "watch_build",
        message: e.message ?? String(e),
        stack: e.stack ?? null,
        dedupeSec: 60,
      });
      send(ws, { type: "error", error: e.message ?? String(e) });
    });
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
  if (watchPushBusy) return;
  watchPushBusy = true;
  getWatchSnapshot()
    .then((data) => {
      const payload = JSON.stringify({ type: "watch", data });
      for (const ws of clients.keys()) {
        if (ws.readyState === 1) ws.send(payload);
      }
    })
    .catch((e) => {
      const payload = JSON.stringify({ type: "error", error: e.message ?? String(e) });
      for (const ws of clients.keys()) {
        if (ws.readyState === 1) ws.send(payload);
      }
    })
    .finally(() => { watchPushBusy = false; });
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
