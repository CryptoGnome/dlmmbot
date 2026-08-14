import type { ErrorLogEntry } from "./types";

export type ErrorKind = "incident" | "transient" | "degraded";

export type ErrorPresentation = {
  label: string;
  kind: ErrorKind;
  hint?: string;
};

const KIND_LABEL: Record<ErrorKind, string> = {
  incident: "Needs attention",
  transient: "Transient",
  degraded: "Degraded",
};

export function kindLabel(kind: ErrorKind): string {
  return KIND_LABEL[kind];
}

function isTimeout(msg: string): boolean {
  return msg.includes("timeout")
    || msg.includes("aborted due to timeout")
    || msg.includes("etimedout")
    || msg.includes("econnreset");
}

/** Fallback for rows logged before labels were stored. */
function classifyLegacy(e: ErrorLogEntry): ErrorPresentation {
  const msg = e.message.toLowerCase();
  const stack = (e.stack ?? "").toLowerCase();

  if (e.code === "open_failed") {
    return {
      label: e.source === "majors" ? "Majors entry failed" : "Entry transaction failed",
      kind: "incident",
      hint: "Open tx did not land — check wallet balance and pool state.",
    };
  }
  if (e.code === "position_act") {
    return { label: "Position action failed", kind: "incident" };
  }
  if (e.code === "rpc_probe") {
    return {
      label: e.level === "error" ? "RPC offline" : "RPC probe failed",
      kind: e.level === "error" ? "incident" : "degraded",
    };
  }
  if (e.source === "gmgn" && e.code === "rate_limit") {
    return {
      label: "GMGN rate limited",
      kind: "degraded",
      hint: "Trending/vetting paused — Meteora scan continues.",
    };
  }
  if (isTimeout(msg) && (stack.includes("meteora") || e.source === "scanner" || e.code === "sweep_failed")) {
    return {
      label: "Pool scan timed out",
      kind: "transient",
      hint: "Meteora API was slow — one scan skipped. Positions still managed.",
    };
  }
  if (isTimeout(msg)) {
    return { label: "Network timeout", kind: "transient", hint: "External service slow — bot retries." };
  }
  return {
    label: `${e.source}${e.code ? ` · ${e.code}` : ""}`,
    kind: e.level === "warn" ? "degraded" : "incident",
  };
}

export function errorPresentation(e: ErrorLogEntry): ErrorPresentation {
  if (e.label && e.kind) {
    return { label: e.label, kind: e.kind as ErrorKind, hint: e.hint ?? undefined };
  }
  return classifyLegacy(e);
}

export function kindTone(kind: ErrorKind): "danger" | "warn" | "accent" {
  if (kind === "transient") return "accent";
  if (kind === "degraded") return "warn";
  return "danger";
}
