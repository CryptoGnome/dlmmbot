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
//   */2 * * * * cd /path/to/dlmmbot && node deploy/heartbeat-check.cjs >> /tmp/farmer-heartbeat.log 2>&1
//
// Exit codes: 0 healthy, 1 stale/missing (alert sent), 2 could not check
// (alerts after every CHECK_FAIL_EVERY_N consecutive failures).

const { readFileSync, existsSync, writeFileSync, unlinkSync } = require("node:fs");
const { resolve } = require("node:path");
const { evaluateHeartbeat, shouldAlert, shouldAlertCheckFailure } = require("./heartbeat-logic.cjs");

const ROOT = resolve(__dirname, "..");
const DB_PATH = process.env.FARMER_DB_PATH || resolve(ROOT, "data/farmer.db");
const STATE = process.env.FARMER_HEARTBEAT_STATE || "/tmp/farmer-heartbeat-state";
const FAIL_STATE = `${STATE}-fails`;

// Same env resolution as the farmer: the wizard / dashboard Settings /
// ecosystem FARMER_ENV_PATH write Telegram creds to data/.env, not <repo>/.env.
// Reading only the repo .env made the checker a silent no-op for those users.
// Merge order: repo .env first, then FARMER_ENV_PATH (default data/.env) wins.
function parseEnvFile(path, into) {
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) into[m[1]] = m[2];
    }
  } catch { /* file absent — fine */ }
  return into;
}

function loadEnv() {
  const vars = parseEnvFile(resolve(ROOT, ".env"), {});
  parseEnvFile(process.env.FARMER_ENV_PATH || resolve(ROOT, "data/.env"), vars);
  return vars;
}

const FILE_ENV = loadEnv();
function env(key) {
  return FILE_ENV[key] || process.env[key] || "";
}

/** @returns {Promise<boolean>} true only when Telegram accepted the message. */
async function notify(text) {
  console.log(`[heartbeat] ${text}`);
  const token = env("TELEGRAM_BOT_TOKEN");
  const chat = env("TELEGRAM_CHAT_ID");
  if (!token || !chat) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `meteora-farmer\n💀 [heartbeat] ${text}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[heartbeat] telegram send failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[heartbeat] telegram send failed:", e.message);
    return false;
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

function readFailCount() {
  try { return Number(readFileSync(FAIL_STATE, "utf8").trim()) || 0; } catch { return 0; }
}

function writeFailCount(n) {
  try { writeFileSync(FAIL_STATE, String(n)); } catch { /* best effort */ }
}

function clearFailCount() {
  try { if (existsSync(FAIL_STATE)) unlinkSync(FAIL_STATE); } catch { /* best effort */ }
}

// The exit-2 paths ("could not even check") used to log to /tmp forever without
// alerting — but sqlite-won't-load / DB-unreadable are states in which the
// farmer is certainly not trading. Count consecutive failures and page every
// Nth one, so one transient blip stays quiet but a persistent one does not.
async function checkFailed(why) {
  const fails = readFailCount() + 1;
  writeFailCount(fails);
  if (shouldAlertCheckFailure(fails)) {
    await notify(`heartbeat checker could not check the farmer ${fails} consecutive times — latest: ${why}. The bot's state is unknown; check the server.`);
  }
  process.exit(2);
}

(async () => {
  const nowS = Math.floor(Date.now() / 1000);

  let Database;
  try {
    Database = require(resolve(ROOT, "node_modules/better-sqlite3"));
  } catch (e) {
    console.error("[heartbeat] cannot load better-sqlite3:", e.message);
    await checkFailed(`cannot load better-sqlite3: ${e.message}`);
  }

  let hb = null;
  try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'heartbeat'").get();
    db.close();
    if (row) hb = JSON.parse(row.value);
  } catch (e) {
    console.error("[heartbeat] db read failed:", e.message);
    await checkFailed(`db read failed: ${e.message}`);
  }

  clearFailCount(); // the check itself worked — reset the "could not check" streak

  const result = evaluateHeartbeat(hb, nowS);
  if (result.status !== "ok") {
    if (shouldAlert(nowS, readLastAlert())) {
      // Stamp only after Telegram accepts the message: stamping first meant a
      // failed send suppressed retries for the whole reminder window.
      if (await notify(result.message)) writeLastAlert(nowS);
    }
    process.exit(1);
  }

  clearAlert();
  console.log(`[heartbeat] ok — ${result.age}s old, pid ${hb.pid}, build ${hb.build}, ${hb.open || 0} open` +
    (hb.entriesFrozen ? ", ENTRIES FROZEN" : ""));
})();
