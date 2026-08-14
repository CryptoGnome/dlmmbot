/**
 * AES-256-GCM wallet encryption at rest (scrypt key from passphrase).
 * Private key never leaves the server after generate/import except one-time backup.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { TERMS_VERSION, termsAccepted } from "./terms.mjs";

// scrypt cost for NEW blobs. Old blobs store their own N/r/p and still unlock
// (decryptSecret derives with the params persisted in the blob).
const N = 2 ** 17; // ~128MB memory-hard — slows offline passphrase cracking
const R = 8;
const P = 1;
const KEY_LEN = 32;
// Must exceed 128 * N * r bytes for the largest params we derive with.
const MAXMEM = 256 * 1024 * 1024;
const MIN_PASSPHRASE = 10;

function walletPath() {
  const base = process.env.FARMER_ENV_PATH
    ? dirname(resolve(process.env.FARMER_ENV_PATH))
    : process.env.FARMER_DB_PATH
      ? dirname(resolve(process.env.FARMER_DB_PATH))
      : resolve(process.cwd(), "data");
  return resolve(base, "wallet.enc.json");
}

function setupPath() {
  return resolve(dirname(walletPath()), "setup.json");
}

function deriveKey(passphrase, salt, params = { N, r: R, p: P }) {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: params.N, r: params.r, p: params.p, maxmem: MAXMEM,
  });
}

export function encryptSecret(plain, passphrase) {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    kdf: "scrypt",
    N, r: R, p: P,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
}

export function decryptSecret(blob, passphrase) {
  if (!blob || blob.v !== 1) throw new Error("unsupported wallet blob");
  const salt = Buffer.from(blob.salt, "base64");
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");
  const data = Buffer.from(blob.data, "base64");
  const key = deriveKey(passphrase, salt, {
    N: blob.N || N,
    r: blob.r || R,
    p: blob.p || P,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function hasEncryptedWallet() {
  return existsSync(walletPath());
}

export function readWalletMeta() {
  if (!hasEncryptedWallet()) return null;
  try {
    const j = JSON.parse(readFileSync(walletPath(), "utf8"));
    return { publicKey: j.publicKey ?? null, createdAt: j.createdAt ?? null };
  } catch {
    return null;
  }
}

function writeWalletFile(publicKey, encBlob) {
  const path = walletPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    publicKey,
    createdAt: new Date().toISOString(),
    enc: encBlob,
  }, null, 2), "utf8");
}

export function generateAndEncrypt(passphrase, { overwrite = false } = {}) {
  if (hasEncryptedWallet() && !overwrite) {
    throw new Error("encrypted wallet already exists — pass overwrite to replace");
  }
  const kp = Keypair.generate();
  const secret = bs58.encode(kp.secretKey);
  const publicKey = kp.publicKey.toBase58();
  writeWalletFile(publicKey, encryptSecret(secret, passphrase));
  return { publicKey, secretOnce: secret };
}

export function importAndEncrypt(secretBase58, passphrase, { overwrite = false } = {}) {
  if (hasEncryptedWallet() && !overwrite) {
    throw new Error("encrypted wallet already exists — pass overwrite to replace");
  }
  const raw = String(secretBase58 || "").trim();
  if (!raw) throw new Error("private key required");
  let kp;
  try {
    kp = Keypair.fromSecretKey(bs58.decode(raw));
  } catch {
    throw new Error("invalid private key — paste Phantom base58 export");
  }
  const publicKey = kp.publicKey.toBase58();
  writeWalletFile(publicKey, encryptSecret(bs58.encode(kp.secretKey), passphrase));
  return { publicKey };
}

export function unlockEncryptedWallet(passphrase) {
  const path = walletPath();
  if (!existsSync(path)) throw new Error("no encrypted wallet on disk");
  const j = JSON.parse(readFileSync(path, "utf8"));
  const secret = decryptSecret(j.enc, passphrase);
  // Validate
  const kp = Keypair.fromSecretKey(bs58.decode(secret));
  return {
    publicKey: kp.publicKey.toBase58(),
    secret,
  };
}

export function clearEncryptedWallet() {
  const path = walletPath();
  if (existsSync(path)) unlinkSync(path);
}

export function readSetupState() {
  try {
    return JSON.parse(readFileSync(setupPath(), "utf8"));
  } catch {
    return {
      completed: false,
      completedAt: null,
      skipped: false,
      termsVersion: null,
      termsAcceptedAt: null,
    };
  }
}

export function writeSetupState(partial) {
  const path = setupPath();
  mkdirSync(dirname(path), { recursive: true });
  const prev = readSetupState();
  const next = { ...prev, ...partial };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function setupStatus(envMasked) {
  const byKey = Object.fromEntries((envMasked || []).map((r) => [r.key, r]));
  const walletMeta = readWalletMeta();
  const setup = readSetupState();
  const hasPlainWallet = !!(byKey.WALLET_PRIVATE_KEY?.set || byKey.WALLET_KEYPAIR_PATH?.set);
  const encrypted = hasEncryptedWallet();
  const hasWallet = encrypted || hasPlainWallet;
  const hasRpc = !!byKey.RPC_URL?.set;
  const hasJupiterApiKey = !!byKey.JUPITER_API_KEY?.set;
  const hasGmgnApiKey = !!byKey.GMGN_API_KEY?.set;
  const mode = byKey.FARMER_MODE?.value || process.env.FARMER_MODE || "paper";
  const coreReady = hasWallet && hasRpc;
  // Skip full wizard for already-configured boxes (volume with RPC + wallet).
  const needsWizard = !setup.completed && !setup.skipped && !coreReady;
  const needsTerms = !termsAccepted(setup);

  let publicKey = walletMeta?.publicKey || null;
  if (!publicKey) {
    publicKey = process.env.WALLET_PUBKEY || process.env.PUBLIC_WALLET || null;
  }
  if (!publicKey && process.env.WALLET_PRIVATE_KEY) {
    try {
      publicKey = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY)).publicKey.toBase58();
    } catch { /* bad key — leave null */ }
  }

  // env = plain key already in .env (classic / working bot). encrypted = wallet.enc.json on disk.
  const source = hasPlainWallet ? (encrypted ? "unlocked" : "env") : encrypted ? "encrypted" : "none";

  return {
    needsWizard,
    needsTerms,
    termsVersion: TERMS_VERSION,
    setup: {
      completed: !!setup.completed,
      skipped: !!setup.skipped,
      completedAt: setup.completedAt ?? null,
      termsVersion: setup.termsVersion ?? null,
      termsAcceptedAt: setup.termsAcceptedAt ?? null,
    },
    wallet: {
      encrypted,
      unlocked: hasPlainWallet,
      ready: hasWallet,
      source,
      publicKey,
      createdAt: walletMeta?.createdAt ?? null,
    },
    hasRpc,
    hasJupiterApiKey,
    hasGmgnApiKey,
    farmerMode: mode,
    coreReady,
  };
}
