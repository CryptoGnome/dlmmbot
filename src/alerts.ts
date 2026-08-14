// Alerting (§8): Telegram + console. Configure TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID in .env; without them alerts degrade to console-only.
// Used for events the operator must know about without watching a terminal:
// P0 safety exits, stop losses, circuit breaker, watchdog, displacements.

export type AlertKind =
  | "safety_exit" | "stop_loss" | "below_cut" | "circuit_breaker"
  | "watchdog" | "displacement" | "entry" | "close" | "claim"
  | "profit_lock" | "account" | "info";

const EMOJI: Record<AlertKind, string> = {
  safety_exit: "🚨", stop_loss: "🛑", below_cut: "📉", circuit_breaker: "⛔",
  watchdog: "🕶️", displacement: "🔄", entry: "🟢", close: "🏁", claim: "💰",
  profit_lock: "🔒", account: "📊", info: "ℹ️",
};

const MIN_INTERVAL_MS = 3_000; // basic flood guard

// Serialized send queue. The old guard snapshotted a shared lastSend inside
// each fire-and-forget IIFE, so a burst (close report + account summary +
// claim in one tick — the norm around a close) all slept to the same deadline
// and fired simultaneously; Telegram 429'd and the response was never checked,
// silently dropping exactly the P0/stop alerts this module exists for.
let sendChain: Promise<void> = Promise.resolve();

async function sendTelegram(token: string, chatId: string, line: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `meteora-farmer\n${line}` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const body = (await res.json().catch(() => null)) as { parameters?: { retry_after?: number } } | null;
      const waitS = Math.min(body?.parameters?.retry_after ?? 5, 30);
      await new Promise((r) => setTimeout(r, waitS * 1000));
      continue;
    }
    throw new Error(`telegram HTTP ${res.status}`);
  }
}

export async function alert(kind: AlertKind, message: string): Promise<void> {
  const line = `${EMOJI[kind]} [${kind}] ${message}`;
  console.log(`[alert] ${line}`);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  // Fire-and-forget but serialized: callers never wait (Telegram RTT + flood
  // sleep used to stretch the manage tick past 60s position_marks gaps), while
  // the chain spaces sends MIN_INTERVAL_MS apart in order.
  sendChain = sendChain
    .then(() => new Promise((r) => setTimeout(r, MIN_INTERVAL_MS)))
    .then(() => sendTelegram(token, chatId, line))
    .catch((e) => console.error("[alert] telegram send failed:", (e as Error).message));
}
