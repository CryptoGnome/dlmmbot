import { Keypair } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import bs58 from "bs58";

/**
 * Load the burner-wallet keypair. Sources, in priority order:
 *   1. WALLET_PRIVATE_KEY — base58 secret key string as exported by Phantom
 *   2. WALLET_KEYPAIR_PATH — solana-keygen JSON array file
 * Only the live executor calls this — scanner and vetting never touch keys.
 * Never log the secret.
 */
export function loadKeypair(
  privateKey: string | undefined,
  path: string | undefined,
): Keypair {
  if (privateKey) {
    let decoded: Uint8Array;
    try {
      decoded = bs58.decode(privateKey.trim());
    } catch {
      throw new Error("WALLET_PRIVATE_KEY is not valid base58 (paste the Phantom export unmodified)");
    }
    if (decoded.length !== 64) {
      throw new Error(`WALLET_PRIVATE_KEY decodes to ${decoded.length} bytes, expected 64`);
    }
    return Keypair.fromSecretKey(decoded);
  }
  if (!path) {
    throw new Error("set WALLET_PRIVATE_KEY or WALLET_KEYPAIR_PATH — required for live mode");
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  if (!Array.isArray(raw) || raw.length !== 64) {
    throw new Error("keypair file is not a 64-byte solana-keygen JSON array");
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
