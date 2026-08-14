// Pure heartbeat decision helpers — kept free of DB/Telegram so unit tests
// cannot share a failure mode with the live checker (deploy/heartbeat-check.cjs).

const STALE_S = 300;
const REMIND_S = 3600;
const CHECK_FAIL_EVERY_N = 5;

function evaluateHeartbeat(hb, nowS, staleS = STALE_S) {
  if (!hb || typeof hb.ts !== "number") {
    return { status: "missing", age: null, message: "no heartbeat row in the DB — farmer has not completed a tick on this build" };
  }
  const age = nowS - hb.ts;
  if (age > staleS) {
    return {
      status: "stale",
      age,
      message:
        `farmer heartbeat is ${Math.floor(age / 60)}m stale (last tick ${new Date(hb.ts * 1000).toISOString()}, ` +
        `pid ${hb.pid}, build ${hb.build}). ${hb.open || 0} position(s) were open. ` +
        `The process is not completing ticks — check \`pm2 list\` and the logs.`,
    };
  }
  return { status: "ok", age, message: null };
}

/** Alert on falling edge, then at most every remindS while still down. */
function shouldAlert(nowS, lastAlertS, remindS = REMIND_S) {
  const last = Number(lastAlertS) || 0;
  return nowS - last >= remindS;
}

/**
 * "Could not even check" (sqlite failed to load / DB unreadable) is a state in
 * which the farmer is certainly not trading, so it must eventually page too —
 * but not on the first blip. Alert every Nth consecutive failure.
 */
function shouldAlertCheckFailure(consecutiveFails, everyN = CHECK_FAIL_EVERY_N) {
  const n = Number(consecutiveFails) || 0;
  return n > 0 && n % everyN === 0;
}

module.exports = { STALE_S, REMIND_S, CHECK_FAIL_EVERY_N, evaluateHeartbeat, shouldAlert, shouldAlertCheckFailure };
