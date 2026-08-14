/**
 * Fingerprint of the built SPA in dashboard/dist — used so an open browser
 * tab can detect a new UI after deploy and prompt Reload.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @param {string} html */
export function fingerprintDashHtml(html) {
  const refs = [...String(html || "").matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)]
    .map((m) => m[1]);
  const key = refs.length ? refs.sort().join("|") : String(html || "");
  if (!key.trim()) return null;
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** @param {string} root repo root */
export function readDashUiBuild(root) {
  const index = join(root, "dashboard", "dist", "index.html");
  if (!existsSync(index)) return null;
  try {
    return fingerprintDashHtml(readFileSync(index, "utf8"));
  } catch {
    return null;
  }
}
