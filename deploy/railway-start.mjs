#!/usr/bin/env node
/**
 * Single-process Railway entry: farmer + dashboard.
 * Persists DB / config / .env on the attached volume when present.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyRuntimeEnv } from "./lib/runtime-paths.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const paths = applyRuntimeEnv(root);
const configPath = paths.configPath;
const envPath = paths.envPath;
const dbPath = paths.dbPath;

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* */ }
}

loadEnvFile(resolve(root, ".env"));
loadEnvFile(envPath);

if (!process.env.FARMER_MODE) process.env.FARMER_MODE = "paper";
process.env.FARMER_DB_PATH = process.env.FARMER_DB_PATH || dbPath;
process.env.FARMER_CONFIG_PATH = process.env.FARMER_CONFIG_PATH || configPath;
process.env.FARMER_ENV_PATH = process.env.FARMER_ENV_PATH || envPath;
process.env.FARMER_ROOT = root;

// Railway public URL uses PORT
const port = process.env.PORT || process.env.DASH_PORT || "8787";
process.env.DASH_PORT = String(port);

if (!process.env.DASH_TOKEN) {
  // 32 bytes → 64 hex chars. Full value is written to the volume .env — never
  // printed whole (deploy logs get screenshotted). Prefer setting DASH_TOKEN as
  // a Railway variable so the same token survives and you never need logs.
  const token = randomBytes(32).toString("hex");
  process.env.DASH_TOKEN = token;
  const line = `DASH_TOKEN=${token}\n`;
  try {
    writeFileSync(envPath, existsSync(envPath) ? `${readFileSync(envPath, "utf8").replace(/\s*$/, "")}\n${line}` : line);
  } catch { /* */ }
  console.log(`[railway] generated DASH_TOKEN=${token.slice(0, 8)}… (full value only in ${envPath} on the volume)`);
  console.log("[railway] set DASH_TOKEN as a Railway variable (same value) so login works and the token never rotates");
  console.log("[railway] generate offline: node -e \"console.log(require('crypto').randomBytes(24).toString('hex'))\"");
} else if (process.env.DASH_TOKEN.length < 24) {
  console.error(`[railway] FATAL: DASH_TOKEN is too short (${process.env.DASH_TOKEN.length} chars; need ≥24)`);
  process.exit(1);
}

const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (!volume) {
  console.warn("[railway] no volume detected — SQLite & Settings will wipe on every redeploy");
  console.warn("[railway] fix: Railway project canvas → + Create → Volume → attach to this service → Mount path = /app/data → redeploy");
} else {
  console.log(`[railway] volume mount=${volume} db=${dbPath}`);
}

// Optional: unlock encrypted wallet into .env before farmer starts
if (process.env.WALLET_PASSPHRASE && !process.env.WALLET_PRIVATE_KEY) {
  try {
    const { unlockEncryptedWallet, hasEncryptedWallet } = await import("./lib/wallet-crypto.mjs");
    const { applyEnvUpdates } = await import("./lib/config-edit.mjs");
    if (hasEncryptedWallet()) {
      const unlocked = unlockEncryptedWallet(process.env.WALLET_PASSPHRASE);
      applyEnvUpdates(root, {
        WALLET_PRIVATE_KEY: unlocked.secret,
        PUBLIC_WALLET: unlocked.publicKey,
        WALLET_PUBKEY: unlocked.publicKey,
      });
      console.log(`[railway] unlocked encrypted wallet ${unlocked.publicKey.slice(0, 8)}…`);
    }
  } catch (e) {
    console.error(`[railway] wallet unlock failed: ${e.message ?? e}`);
  }
}

console.log(`[railway] mode=${process.env.FARMER_MODE} dash_port=${process.env.DASH_PORT}`);

// Fresh installs: trading engine OFF until the operator finishes setup and
// flips Engine ON. PAUSE lives on the volume so redeploys keep it.
try {
  const { readSetupState } = await import("./lib/wallet-crypto.mjs");
  const { requestPause, readPauseState } = await import("./lib/pause.mjs");
  const setup = readSetupState();
  if (!setup.completed && !setup.skipped) {
    const pause = requestPause(root);
    console.log(`[railway] engine OFF (setup incomplete) — ${pause.path}`);
  } else if (!readPauseState(root).paused) {
    console.log("[railway] engine ON (no PAUSE file)");
  } else {
    console.log("[railway] engine OFF (PAUSE on volume)");
  }
} catch (e) {
  console.warn(`[railway] pause bootstrap skipped: ${e.message ?? e}`);
}

const kids = [];
function run(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    console.error(`[railway] ${label} exited code=${code} signal=${signal}`);
    for (const k of kids) {
      try { k.kill("SIGTERM"); } catch { /* */ }
    }
    process.exit(code ?? 1);
  });
  kids.push(child);
}

run("dash", [resolve(root, "deploy/dashboard-server.mjs")]);
run("farmer", [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(root, "src/cli.ts"), "run"]);

function shutdown(sig) {
  console.log(`[railway] ${sig} — shutting down`);
  for (const k of kids) {
    try { k.kill("SIGTERM"); } catch { /* */ }
  }
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
