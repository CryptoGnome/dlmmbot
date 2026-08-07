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

let lastSend = 0;
const MIN_INTERVAL_MS = 3_000; // basic flood guard

export async function alert(kind: AlertKind, message: string): Promise<void> {
  const line = `${EMOJI[kind]} [${kind}] ${message}`;
  console.log(`[alert] ${line}`);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const since = Date.now() - lastSend;
  if (since < MIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since));
  lastSend = Date.now();

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: `meteora-farmer\n${line}` }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("[alert] telegram send failed:", (e as Error).message);
  }
}
