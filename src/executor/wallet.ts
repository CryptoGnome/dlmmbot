import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";

/**
 * Load the burner-wallet keypair (solana-keygen JSON array format) from the
 * path in WALLET_KEYPAIR_PATH. Only the live executor calls this — scanner and
 * vetting never touch keys. Never log the secret.
 */
export function loadKeypair(path: string | undefined): Keypair {
  if (!path) throw new Error("WALLET_KEYPAIR_PATH is not set — required for live mode");
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error("keypair file is not a 64-byte solana-keygen JSON array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
