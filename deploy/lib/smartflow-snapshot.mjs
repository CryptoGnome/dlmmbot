/**
 * Read farmer-published smartflow snapshot (data/smartflow.json).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimePaths } from "./runtime-paths.mjs";

export function readSmartflowSnapshot(root) {
  const path = join(runtimePaths(root).dataDir, "smartflow.json");
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (!j || typeof j !== "object") return null;
    return {
      at: j.at ?? null,
      ts: typeof j.ts === "number" ? j.ts : null,
      last_poll_at: j.last_poll_at ?? null,
      last_poll_ms: typeof j.last_poll_ms === "number" ? j.last_poll_ms : 0,
      stale: !!j.stale,
      running: !!j.running,
      enabled: j.enabled !== false,
      window_min: typeof j.window_min === "number" ? j.window_min : 30,
      next_feed: j.next_feed === "kol" ? "kol" : "smartmoney",
      trade_count: typeof j.trade_count === "number" ? j.trade_count : 0,
      tokens: Array.isArray(j.tokens) ? j.tokens.slice(0, 40) : [],
      recent: Array.isArray(j.recent) ? j.recent.slice(0, 50) : [],
    };
  } catch {
    return null;
  }
}
