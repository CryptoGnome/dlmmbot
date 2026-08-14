import type { ErrorLevel } from "../db/db.js";

export type ErrorKind = "incident" | "transient" | "degraded";

export type ErrorPresentation = {
  label: string;
  kind: ErrorKind;
  level?: ErrorLevel;
  hint?: string;
};

function isTimeout(msg: string): boolean {
  return msg.includes("timeout")
    || msg.includes("aborted due to timeout")
    || msg.includes("etimedout")
    || msg.includes("econnreset")
    || msg.includes("socket hang up");
}

function humanize(source: string, code: string): string {
  const map: Record<string, string> = {
    "scanner/sweep_failed": "Pool scan failed",
    "farmer/tick": "Main loop interrupted",
    "farmer/reconcile": "Startup reconcile failed",
    "follow/tick": "Follow chain tick failed",
    "watchdog/check": "Health check failed",
    "manager/position_act": "Position action failed",
    "enter/open_failed": "Entry failed",
    "majors/open_failed": "Majors entry failed",
    "follow/open_failed": "Follow leg failed",
  };
  return map[`${source}/${code}`] ?? `${source}${code ? ` · ${code}` : ""}`;
}

/** Plain-language label + severity for dashboard Errors tab. */
export function presentError(input: {
  source: string;
  code?: string | null;
  message: string;
  stack?: string | null;
  level?: ErrorLevel;
}): ErrorPresentation {
  const msg = input.message.toLowerCase();
  const stack = (input.stack ?? "").toLowerCase();
  const source = input.source;
  const code = input.code ?? "";

  if (input.level === "fatal") {
    return {
      label: "Process crash",
      kind: "incident",
      level: "fatal",
      hint: "Uncaught exception — PM2 should restart the farmer automatically.",
    };
  }

  if (code === "open_failed") {
    const label = source === "majors" ? "Majors entry failed"
      : source === "follow" ? "Follow leg failed" : "Entry transaction failed";
    return {
      label,
      kind: "incident",
      hint: "Open tx did not land — check wallet balance, slippage, and pool liquidity.",
    };
  }

  if (code === "position_act") {
    return {
      label: "Position action failed",
      kind: "incident",
      hint: "Close, claim, or mark failed on an open position — bot retries next tick.",
    };
  }

  if (code === "reconcile") {
    return {
      label: "Startup reconcile failed",
      kind: "incident",
      hint: "Bot could not match the DB to chain on boot — review open positions.",
    };
  }

  if (code === "rpc_probe") {
    const severe = input.level === "error";
    return {
      label: severe ? "RPC offline" : "RPC probe failed",
      kind: severe ? "incident" : "degraded",
      level: severe ? "error" : "warn",
      hint: severe
        ? "Repeated RPC failures — new entries frozen until connectivity returns."
        : "Transient RPC blip — bot will retry on the next tick.",
    };
  }

  if (source === "watchdog" && code === "check") {
    return {
      label: "Health check failed",
      kind: "degraded",
      level: "warn",
      hint: "Watchdog probe failed — usually recovers on its own.",
    };
  }

  if (source === "scanner" || code === "sweep_failed") {
    if (isTimeout(msg) || stack.includes("meteora")) {
      return {
        label: "Pool scan timed out",
        kind: "transient",
        level: "warn",
        hint: "Meteora API was slow — one scan cycle skipped (~60s). Open positions still managed.",
      };
    }
    if (msg.includes("datapi") || msg.includes("http ")) {
      return {
        label: "Pool scan API error",
        kind: "transient",
        level: "warn",
        hint: "Meteora datapi returned an error — next scan retries automatically.",
      };
    }
  }

  if (source === "gmgn" && code === "rate_limit") {
    return {
      label: "GMGN rate limited",
      kind: "degraded",
      level: "warn",
      hint: "Optional trending/vetting paused ~5m — Meteora scanning continues. Check for two bots sharing one GMGN key.",
    };
  }

  if (source === "gmgn" && code === "trending_fetch") {
    return {
      label: "GMGN trending unavailable",
      kind: "degraded",
      level: "warn",
      hint: "One trending window failed — scan continues without that bonus.",
    };
  }

  if (isTimeout(msg)) {
    if (stack.includes("meteora") || stack.includes("scanner/")) {
      return {
        label: "Pool scan timed out",
        kind: "transient",
        level: "warn",
        hint: "Meteora API was slow — one scan cycle skipped (~60s). Open positions still managed.",
      };
    }
    if (stack.includes("gmgn")) {
      return {
        label: "Trending data timed out",
        kind: "transient",
        level: "warn",
        hint: "GMGN was slow — scan continues without trending bonus.",
      };
    }
    return {
      label: "Network timeout",
      kind: "transient",
      level: "warn",
      hint: "External service did not respond in time — bot will retry.",
    };
  }

  if (source === "follow" && code === "tick") {
    return {
      label: "Follow chain tick failed",
      kind: "incident",
      hint: "Follow re-entry logic threw — chain state unchanged until next tick.",
    };
  }

  if (source === "farmer" && code === "tick") {
    return {
      label: "Main loop interrupted",
      kind: "incident",
      hint: "Something threw during the farmer tick — review message/stack; positions may still be managed next tick.",
    };
  }

  return { label: humanize(source, code), kind: "incident" };
}
