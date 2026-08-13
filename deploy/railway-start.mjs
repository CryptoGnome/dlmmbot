#!/usr/bin/env node
/**
 * Single-process Railway entry: farmer + dashboard.
 * Persists DB / config / .env on the attached volume when present.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const dataDir = volume && volume.length ? volume : resolve(root, "data");
mkdirSync(dataDir, { recursive: true });

const configPath = join(dataDir, "config.toml");
const envPath = join(dataDir, ".env");
const dbPath = join(dataDir, "farmer.db");

if (!existsSync(configPath)) {
  copyFileSync(resolve(root, "config.toml"), configPath);
  console.log(`[railway] seeded ${configPath}`);
}

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
  const token = randomBytes(24).toString("hex");
  process.env.DASH_TOKEN = token;
  const line = `DASH_TOKEN=${token}\n`;
  try {
    writeFileSync(envPath, existsSync(envPath) ? `${readFileSync(envPath, "utf8").replace(/\s*$/, "")}\n${line}` : line);
  } catch { /* */ }
  console.log(`[railway] generated DASH_TOKEN=${token}`);
  console.log("[railway] open the public URL with ?token=… or paste the token in the login box");
  console.log("[railway] tip: set DASH_TOKEN as a Railway variable to keep the same token forever");
}

if (!volume) {
  console.warn("[railway] no volume detected — attach a volume at /app/data so SQLite & Settings survive redeploys");
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
