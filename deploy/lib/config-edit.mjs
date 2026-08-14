/**
 * Surgical config.toml edits — update key = value lines in-place so comments survive.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "smol-toml";
import { runtimePaths } from "./runtime-paths.mjs";

/**
 * Atomic write: temp file in the same directory + rename over the target, so
 * the bot's 2s hot-reload poll can never observe a half-written config/env.
 */
function writeFileAtomic(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/**
 * In-process write queue — route every config/.env mutation through this so
 * concurrent Settings PATCHes cannot interleave their read-modify-write cycles.
 * (applyConfigUpdates/applyEnvUpdates stay synchronous for boot-time callers
 * like railway-start; HTTP handlers must wrap them: `await queueConfigWrite(...)`.)
 */
let writeChain = Promise.resolve();
export function queueConfigWrite(fn) {
  const run = writeChain.then(() => fn());
  writeChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Sections the Settings UI may edit. Nested tables under majors.pools are excluded. */
const EDITABLE_SECTIONS = new Set([
  "scanner", "gates", "vetting", "timing", "score_caps", "smartflow", "score",
  "entry", "manage", "sizing", "follow", "majors", "rotation", "exec", "gmgn",
  "watchdog", "apis",
]);

function configPath(root) {
  return runtimePaths(root).configPath;
}

export function readConfigToml(root) {
  return readFileSync(configPath(root), "utf8");
}

function fillMissing(target, template) {
  if (!target || !template || typeof target !== "object" || typeof template !== "object") return;
  for (const [key, tmplVal] of Object.entries(template)) {
    const cur = target[key];
    if (cur === undefined) {
      target[key] = tmplVal;
    } else if (
      cur !== null && typeof cur === "object" && !Array.isArray(cur) &&
      tmplVal !== null && typeof tmplVal === "object" && !Array.isArray(tmplVal)
    ) {
      fillMissing(cur, tmplVal);
    }
  }
}

function normalizeSizing(parsed) {
  const s = parsed?.sizing;
  if (!s || typeof s !== "object") return;
  if (s.mode !== "kelly" && s.mode !== "fixed") {
    s.mode = s.kelly_enabled === false ? "fixed" : "kelly";
  }
  s.kelly_enabled = s.mode === "kelly";
}

export function parseConfig(root) {
  const parsed = parse(readConfigToml(root));
  normalizeSizing(parsed);
  try {
    const tmpl = parse(readFileSync(join(root, "config.toml"), "utf8"));
    fillMissing(parsed, tmpl);
  } catch { /* no template */ }
  normalizeSizing(parsed);
  return parsed;
}

/** Flatten top-level sections into dotted paths for the Settings form (skip nested objects). */
export function flattenConfig(parsed) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [section, body] of Object.entries(parsed)) {
    if (!EDITABLE_SECTIONS.has(section)) continue;
    if (body == null || typeof body !== "object" || Array.isArray(body)) continue;
    for (const [key, val] of Object.entries(body)) {
      if (val != null && typeof val === "object" && !Array.isArray(val)) continue;
      if (Array.isArray(val) && val.some((v) => v != null && typeof v === "object")) continue;
      out[`${section}.${key}`] = val;
    }
  }
  return out;
}

function formatTomlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v))).join(", ")}]`;
  }
  throw new Error(`unsupported value type: ${typeof value}`);
}

/**
 * Replace `key = …` inside `[section]` only.
 * @param {string} text
 * @param {string} section
 * @param {string} key
 * @param {unknown} value
 */
function patchSectionKey(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  let found = false;
  const formatted = formatTomlValue(value);
  const keyRe = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*).*?(?=\\s*(#.*)?$)`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const sectionHdr = /^\[([^\]]+)\]/.exec(trimmed);
    if (sectionHdr) {
      inSection = sectionHdr[1] === section;
      continue;
    }
    if (!inSection) continue;
    if (keyRe.test(line)) {
      let comment = "";
      const hash = line.indexOf("#");
      if (hash >= 0) {
        const before = line.slice(0, hash);
        if ((before.match(/"/g) || []).length % 2 === 0) {
          comment = "  " + line.slice(hash).trim();
        }
      }
      const m = keyRe.exec(line);
      lines[i] = `${m[1]}${formatted}${comment}`;
      found = true;
      break;
    }
  }
  return { text: lines.join("\n"), found };
}

/**
 * Append `key = value` at the end of an existing `[section]` (before the next
 * section header, skipping trailing blank lines).
 */
function appendSectionKey(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  let sectionStart = -1;
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const hdr = /^\s*\[([A-Za-z0-9_.]+)\]/.exec(lines[i]);
    if (!hdr) continue;
    if (sectionStart >= 0) { insertAt = i; break; }
    if (hdr[1] === section) sectionStart = i;
  }
  if (sectionStart < 0) return { text, found: false };
  if (insertAt < 0) insertAt = lines.length;
  let at = insertAt;
  while (at > sectionStart + 1 && lines[at - 1].trim() === "") at--;
  lines.splice(at, 0, `${key} = ${formatTomlValue(value)}`);
  return { text: lines.join("\n"), found: true };
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} updates dotted keys section.key
 */
export function applyConfigUpdates(root, updates) {
  if (!updates || typeof updates !== "object") throw new Error("updates object required");
  /** Keep sizing.mode ↔ kelly_enabled mirrored for profiles / older UIs. */
  const synced = { ...updates };
  if (synced["sizing.mode"] === "kelly" || synced["sizing.mode"] === "fixed") {
    synced["sizing.kelly_enabled"] = synced["sizing.mode"] === "kelly";
  } else if ("sizing.kelly_enabled" in synced) {
    synced["sizing.mode"] = synced["sizing.kelly_enabled"] ? "kelly" : "fixed";
  }
  let text = readConfigToml(root);
  const missing = [];
  const applied = [];
  /** Repo template, parsed lazily — the authority on which keys exist at all. */
  let template = null;
  const templateHas = (section, key) => {
    if (template === null) {
      try { template = parse(readFileSync(join(root, "config.toml"), "utf8")); } catch { template = {}; }
    }
    return template?.[section]?.[key] !== undefined;
  };

  for (const [path, value] of Object.entries(synced)) {
    const dot = path.indexOf(".");
    if (dot <= 0) throw new Error(`invalid path: ${path}`);
    const section = path.slice(0, dot);
    const key = path.slice(dot + 1);
    if (!EDITABLE_SECTIONS.has(section)) throw new Error(`section not editable: ${section}`);
    if (key.includes(".")) throw new Error(`nested path not supported: ${path}`);
    const before = text;
    const res = patchSectionKey(text, section, key, value);
    text = res.text;
    if (!res.found) {
      // The runtime config was seeded before this key existed (data/config.toml
      // is copied exactly once). If the repo TEMPLATE knows the key, append it
      // to the section so Settings and profiles can heal an outdated file;
      // keys the template doesn't know still hard-error (typo protection).
      if (templateHas(section, key)) {
        const app = appendSectionKey(text, section, key, value);
        if (app.found) {
          text = app.text;
          applied.push(path);
          continue;
        }
      }
      missing.push(path);
    } else if (text !== before) {
      applied.push(path);
    }
  }

  if (missing.length) throw new Error(`unknown keys: ${missing.join(", ")}`);
  if (applied.length) writeFileAtomic(configPath(root), text);
  return { applied, config: flattenConfig(parseConfig(root)) };
}

/** Env keys whose values must never leave the server in API responses. */
const SENSITIVE_ENV = new Set([
  "DASH_TOKEN",
  "RPC_URL",
  "RPC_URL_FALLBACK",
  "WALLET_PUBKEY",
  "PUBLIC_WALLET",
  "WALLET_PRIVATE_KEY",
  "WALLET_KEYPAIR_PATH",
  "JUPITER_API_KEY",
  "GMGN_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
]);

/** Keys the unlock panel may write (blank = leave unchanged). */
export const SECRET_EDIT_KEYS = [
  "RPC_URL",
  "RPC_URL_FALLBACK",
  "WALLET_PUBKEY",
  "PUBLIC_WALLET",
  "WALLET_PRIVATE_KEY",
  "WALLET_KEYPAIR_PATH",
  "JUPITER_API_KEY",
  "GMGN_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "FARMER_MODE",
];

const SECRET_EDIT_SET = new Set(SECRET_EDIT_KEYS);

/** Solana pubkeys are base58, 32–44 chars. These env keys end up in URLs and
 * child-process context downstream — reject anything that isn't a pubkey. */
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBKEY_ENV_KEYS = new Set(["WALLET_PUBKEY", "PUBLIC_WALLET"]);

function envPath(root) {
  return runtimePaths(root).envPath;
}

/** Status-only env snapshot — sensitive values are never included. */
export function readEnvMasked(root = process.cwd()) {
  // root unused for process.env read; kept for API symmetry with writers
  void root;
  const safeKeys = ["FARMER_MODE", "DASH_PORT", "DEPLOY_BRANCH"];
  const statusKeys = [
    ...safeKeys,
    ...SECRET_EDIT_KEYS.filter((k) => !safeKeys.includes(k)),
  ];

  return statusKeys.map((key) => {
    const raw = process.env[key];
    const set = raw != null && String(raw).length > 0;
    const sensitive = SENSITIVE_ENV.has(key) || /PRIVATE|KEYPAIR|MNEMONIC|SECRET|TOKEN|_KEY$/i.test(key);
    return {
      key,
      set,
      secret: sensitive,
      /** Safe keys only — never leak RPC / wallet / tokens / keys. */
      value: !set || sensitive ? null : String(raw),
      editable: SECRET_EDIT_SET.has(key),
    };
  });
}

/**
 * Patch .env keys. Never logs values. Updates process.env for this process.
 * @param {string} root
 * @param {Record<string, string>} updates
 */
export function applyEnvUpdates(root, updates) {
  if (!updates || typeof updates !== "object") throw new Error("updates object required");
  const path = envPath(root);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = "";
  }

  const applied = [];
  for (const [key, rawVal] of Object.entries(updates)) {
    if (!SECRET_EDIT_SET.has(key)) throw new Error(`env key not editable: ${key}`);
    if (typeof rawVal !== "string") throw new Error(`${key}: string required`);
    const value = rawVal.trim();
    if (!value) continue; // blank = keep existing
    if (PUBKEY_ENV_KEYS.has(key) && !BASE58_PUBKEY_RE.test(value)) {
      throw new Error(`${key}: not a valid base58 Solana public key`);
    }

    const lineRe = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*).*$`, "m");
    const escaped = value.replace(/\r?\n/g, "");
    if (lineRe.test(text)) {
      text = text.replace(lineRe, `$1${escaped}`);
    } else {
      text = `${text.replace(/\s*$/, "")}\n${key}=${escaped}\n`;
    }
    process.env[key] = escaped;
    applied.push(key);
  }

  if (applied.length) writeFileAtomic(path, text);
  return { applied, env: readEnvMasked(root) };
}
