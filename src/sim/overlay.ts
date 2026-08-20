import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import type { ConfigOverlay } from "./types.js";

/** `--set manage.stop_loss_frac=0.65` → 0.65, `=true` → true, else the string. */
export function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return raw !== "" && !Number.isNaN(n) ? n : raw;
}

/**
 * Apply dotted `section.key` updates to a config, rejecting keys the real
 * Config does not have. Unknown keys throw rather than being dropped: a typo
 * that silently changes nothing reads as "this setting makes no difference",
 * which is the most expensive wrong answer a simulator can give.
 */
export function applyOverlay(base: Config, overlay: ConfigOverlay): Config {
  const next = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(overlay)) {
    const [section, name] = key.split(".");
    if (!section || !name) throw new Error(`config key must be "section.key", got "${key}"`);
    const sec = next[section];
    if (!sec || typeof sec !== "object" || Array.isArray(sec)) {
      throw new Error(`no config section "${section}" (in "${key}")`);
    }
    if (!(name in sec)) {
      throw new Error(`config key "${key}" does not exist — a typo here would silently do nothing`);
    }
    sec[name] = value;
  }
  return next as unknown as Config;
}

/** Load a shipped profile (`aggressive`) or a path to any profile JSON. */
export function loadProfile(idOrPath: string): { label: string; overlay: ConfigOverlay } {
  const path = idOrPath.endsWith(".json") ? idOrPath : `profiles/official/${idOrPath}.json`;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { id?: string; updates?: ConfigOverlay };
  return { label: `profile:${raw.id ?? idOrPath}`, overlay: raw.updates ?? {} };
}

/**
 * Profiles carry entry/sizing/vetting keys the mark replay cannot honour —
 * keep only the ones that change an exit, so a profile comparison never
 * implies the simulator tested gates or position sizing.
 */
export function exitKeysOnly(overlay: ConfigOverlay): { kept: ConfigOverlay; ignored: string[] } {
  const kept: ConfigOverlay = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(overlay)) {
    if (k.startsWith("manage.") || k.startsWith("majors.")) kept[k] = v;
    else ignored.push(k);
  }
  return { kept, ignored };
}
