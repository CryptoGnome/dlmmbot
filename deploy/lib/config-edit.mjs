/**
 * Surgical config.toml edits — update key = value lines in-place so comments survive.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";

/** Sections the Settings UI may edit. Nested tables under majors.pools are excluded. */
const EDITABLE_SECTIONS = new Set([
  "scanner", "gates", "vetting", "timing", "score_caps", "smartflow", "score",
  "entry", "manage", "sizing", "follow", "majors", "rotation", "exec", "gmgn",
  "watchdog", "apis", "profit_burn",
]);

function configPath(root) {
  return resolve(root, "config.toml");
}

export function readConfigToml(root) {
  return readFileSync(configPath(root), "utf8");
}

export function parseConfig(root) {
  return parse(readConfigToml(root));
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
 * @param {string} root
 * @param {Record<string, unknown>} updates dotted keys section.key
 */
export function applyConfigUpdates(root, updates) {
  if (!updates || typeof updates !== "object") throw new Error("updates object required");
  let text = readConfigToml(root);
  const missing = [];
  const applied = [];

  for (const [path, value] of Object.entries(updates)) {
    const dot = path.indexOf(".");
    if (dot <= 0) throw new Error(`invalid path: ${path}`);
    const section = path.slice(0, dot);
    const key = path.slice(dot + 1);
    if (!EDITABLE_SECTIONS.has(section)) throw new Error(`section not editable: ${section}`);
    if (key.includes(".")) throw new Error(`nested path not supported: ${path}`);
    const before = text;
    const res = patchSectionKey(text, section, key, value);
    text = res.text;
    if (!res.found) missing.push(path);
    else if (text !== before) applied.push(path);
  }

  if (missing.length) throw new Error(`unknown keys: ${missing.join(", ")}`);
  if (applied.length) writeFileSync(configPath(root), text, "utf8");
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
];

const SECRET_EDIT_SET = new Set(SECRET_EDIT_KEYS);

function envPath(root) {
  return resolve(root, ".env");
}

/** Status-only env snapshot — sensitive values are never included. */
export function readEnvMasked(root = process.cwd()) {
  // root unused for process.env read; kept for API symmetry with writers
  void root;
  const safeKeys = ["FARMER_MODE", "DASH_PORT", "DEPLOY_BRANCH"];
  const statusKeys = [
    ...safeKeys,
    ...SECRET_EDIT_KEYS,
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

  if (applied.length) writeFileSync(path, text, "utf8");
  return { applied, env: readEnvMasked(root) };
}
