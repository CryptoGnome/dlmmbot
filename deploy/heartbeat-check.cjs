#!/usr/bin/env node
// Out-of-process liveness check for meteora-farmer. Run from cron.
//
// Why this exists outside the bot: every alert the farmer sends is emitted from
// inside the farmer, so none of them can tell you the farmer is gone. "No
// Telegram messages" is indistinguishable from "quiet market". This is the only
// thing that makes *the bot is not running* an alertable state.
//
// Deliberately dependency-free and src/-free — it must not share a failure mode
// with the thing it watches. Reads the DB read-only, reads .env by hand, and
// posts to Telegram with the same bot token.
//
//   */2 * * * * cd /home/gizmo/meteora-farmer && node deploy/heartbeat-check.cjs >> /tmp/farmer-heartbeat.log 2>&1
//
// Exit codes: 0 healthy, 1 stale/missing (alert sent), 2 could not check.

const { readFileSync, existsSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { evaluateHeartbeat, shouldAlert } = require("./heartbeat-logic.cjs");

const ROOT = resolve(__dirname, "..");
const DB_PATH = process.env.FARMER_DB_PATH || resolve(ROOT, "data/farmer.db");
const STATE = process.env.FARMER_HEARTBEAT_STATE || "/tmp/farmer-heartbeat-state";

function env(key) {
  try {
    for (const line of readFileSync(resolve(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && m[1] === key) return m[2].trim();
    }
  } catch { /* no .env */ }
  return process.env[key] || "";
}

async function notify(text) {
  console.log(`[heartbeat] ${text}`);
  const token = env("TELEGRAM_BOT_TOKEN");
  const chat = env("TELEGRAM_CHAT_ID");
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `meteora-farmer\n💀 [heartbeat] ${text}` }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("[heartbeat] telegram send failed:", e.message);
  }
}

function readLastAlert() {
  try { return Number(readFileSync(STATE, "utf8").trim()) || 0; } catch { return 0; }
}

function writeLastAlert(nowS) {
  try { writeFileSync(STATE, String(nowS)); } catch { /* best effort */ }
}

function clearAlert() {
  try { if (existsSync(STATE)) writeFileSync(STATE, "0"); } catch { /* best effort */ }
}

(async () => {
  const nowS = Math.floor(Date.now() / 1000);

  let Database;
  try {
    Database = require(resolve(ROOT, "node_modules/better-sqlite3"));
  } catch (e) {
    console.error("[heartbeat] cannot load better-sqlite3:", e.message);
    process.exit(2);
  }

  let hb = null;
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'heartbeat'").get();
    db.close();
    if (row) hb = JSON.parse(row.value);
  } catch (e) {
    console.error("[heartbeat] db read failed:", e.message);
    process.exit(2); // do not alert on our own failure to read
  }

  const result = evaluateHeartbeat(hb, nowS);
  if (result.status !== "ok") {
    if (shouldAlert(nowS, readLastAlert())) {
      writeLastAlert(nowS);
      await notify(result.message);
    }
    process.exit(1);
  }

  clearAlert();
  console.log(`[heartbeat] ok — ${result.age}s old, pid ${hb.pid}, build ${hb.build}, ${hb.open || 0} open` +
    (hb.entriesFrozen ? ", ENTRIES FROZEN" : ""));
})();
