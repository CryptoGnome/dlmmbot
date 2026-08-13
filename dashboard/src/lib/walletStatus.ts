import type { EnvRow, SetupStatus } from "@/lib/api";

export type WalletHow =
  | "env"
  | "unlocked"
  | "encrypted_locked"
  | "missing";

export type WalletPresence = {
  ready: boolean;
  how: WalletHow;
  /** Short line for badges / checklist. */
  label: string;
  /** One-line detail under the checklist. */
  detail: string;
  publicKey: string | null;
  /** Env private key present (file or process). */
  envKey: boolean;
  encrypted: boolean;
  unlocked: boolean;
};

/** Merge setup API + env checklist so .env and encrypted wallets both count. */
export function walletPresence(
  setup: SetupStatus | null | undefined,
  secretEnv: EnvRow[] = [],
): WalletPresence {
  const w = setup?.wallet;
  const envKey = !!(
    w?.unlocked
    || w?.source === "env"
    || w?.source === "unlocked"
    || secretEnv.find((r) => r.key === "WALLET_PRIVATE_KEY")?.set
    || secretEnv.find((r) => r.key === "WALLET_KEYPAIR_PATH")?.set
  );
  const encrypted = !!w?.encrypted;
  const unlocked = !!w?.unlocked || envKey;
  const publicKey = w?.publicKey ?? null;
  const ready = !!(w?.ready || envKey || encrypted || publicKey);

  let how: WalletHow = "missing";
  if (envKey && encrypted) how = "unlocked";
  else if (envKey) how = "env";
  else if (encrypted && unlocked) how = "unlocked";
  else if (encrypted) how = "encrypted_locked";
  else if (publicKey) how = "env"; // address known — treat as present

  const shortPk = publicKey
    ? `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`
    : null;

  if (!ready) {
    return {
      ready: false,
      how: "missing",
      label: "needed",
      detail: "not set — create, import, or put WALLET_PRIVATE_KEY in .env",
      publicKey,
      envKey: false,
      encrypted: false,
      unlocked: false,
    };
  }

  if (how === "env") {
    return {
      ready: true,
      how,
      label: "ready",
      detail: shortPk
        ? `ready via .env · ${shortPk}`
        : "ready via .env private key (bot can trade)",
      publicKey,
      envKey,
      encrypted,
      unlocked,
    };
  }

  if (how === "unlocked") {
    return {
      ready: true,
      how,
      label: "ready",
      detail: shortPk
        ? `unlocked encrypted wallet · ${shortPk}`
        : "unlocked encrypted wallet (bot can trade)",
      publicKey,
      envKey,
      encrypted,
      unlocked,
    };
  }

  // encrypted_locked
  return {
    ready: true,
    how: "encrypted_locked",
    label: "locked",
    detail: shortPk
      ? `encrypted on disk · locked · ${shortPk} — unlock to trade`
      : "encrypted on disk · locked — unlock below to trade",
    publicKey,
    envKey,
    encrypted,
    unlocked: false,
  };
}
