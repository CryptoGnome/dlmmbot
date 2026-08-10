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

const ROOT = resolve(__dirname, "..");
const DB_PATH = resolve(ROOT, "data/farmer.db");
const STATE = "/tmp/farmer-heartbeat-state";
const STALE_S = 300;      // 20 ticks at poll_s=15
const REMIND_S = 3600;    // re-alert at most hourly while down

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

// Alert on the falling edge, then at most hourly. Without this a 6-hour outage
// is 180 identical messages and you stop reading them.
function shouldAlert(nowS) {
  let last = 0;
  try { last = Number(readFileSync(STATE, "utf8").trim()) || 0; } catch { /* first run */ }
  if (nowS - last < REMIND_S) return false;
  try { writeFileSync(STATE, String(nowS)); } catch { /* best effort */ }
  return true;
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

  let hb;
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'heartbeat'").get();
    db.close();
    if (!row) {
      // No beacon at all. Either the farmer has never run this build, or the
      // meta row was cleared — both worth a human look, neither is "healthy".
      if (shouldAlert(nowS)) await notify("no heartbeat row in the DB — farmer has not completed a tick on this build");
      process.exit(1);
    }
    hb = JSON.parse(row.value);
  } catch (e) {
    console.error("[heartbeat] db read failed:", e.message);
    process.exit(2); // do not alert on our own failure to read
  }

  const age = nowS - (hb.ts || 0);
  if (age > STALE_S) {
    if (shouldAlert(nowS)) {
      await notify(
        `farmer heartbeat is ${Math.floor(age / 60)}m stale (last tick ${new Date(hb.ts * 1000).toISOString()}, ` +
        `pid ${hb.pid}, build ${hb.build}). ${hb.open || 0} position(s) were open. ` +
        `The process is not completing ticks — check \`pm2 list\` and the logs.`
      );
    }
    process.exit(1);
  }

  clearAlert();
  console.log(`[heartbeat] ok — ${age}s old, pid ${hb.pid}, build ${hb.build}, ${hb.open || 0} open` +
    (hb.entriesFrozen ? ", ENTRIES FROZEN" : ""));
})();
