import {
  createBurnInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { config } from "../config.js";
import { getDb, now } from "../db/db.js";
import { swapFromSol } from "./jupiter.js";

const ACCRUE_KEY = "profit_burn_accrued_sol";

/** Pure: SOL share of measured net profit. Null = no profit / disabled frac. */
export function profitBurnSpendSol(measuredPnlSol: number, profitFrac: number): number | null {
  if (!(measuredPnlSol > 0) || !(profitFrac > 0)) return null;
  const spend = measuredPnlSol * profitFrac;
  return spend > 0 ? spend : null;
}

export function readProfitBurnAccrued(): number {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(ACCRUE_KEY) as
    | { value: string }
    | undefined;
  const n = row ? Number(row.value) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function writeProfitBurnAccrued(sol: number): void {
  const v = Math.max(0, Number.isFinite(sol) ? sol : 0);
  getDb().prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(ACCRUE_KEY, String(v));
}

/** Accrue this close's burn share; return new balance. */
export function accrueProfitBurn(spendSol: number, note: string): number {
  const next = readProfitBurnAccrued() + spendSol;
  writeProfitBurnAccrued(next);
  getDb().prepare(
    "INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'profit_burn_accrue', ?, ?)",
  ).run(now(), spendSol, note);
  return next;
}

async function resolveTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`burn mint account missing: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`burn mint owner is not a token program: ${info.owner.toBase58()}`);
}

/**
 * Spend `spendSol` of wallet SOL → buy burn mint via Jupiter → burn all received.
 * Returns null when swap fails; throws on burn/tx errors for the caller to log.
 */
export async function executeProfitBurn(opts: {
  connection: Connection;
  wallet: Keypair;
  spendSol: number;
  measuredPnlSol: number;
  positionId: number;
  symbol: string;
}): Promise<{ spentSol: number; burnedRaw: string; swapSig: string; burnSig: string } | null> {
  const cfg = config().profit_burn;
  const mint = new PublicKey(cfg.mint);
  const lamports = BigInt(Math.floor(opts.spendSol * 1e9));
  if (lamports <= 0n) return null;

  const swap = await swapFromSol(
    opts.connection,
    opts.wallet,
    mint.toBase58(),
    lamports,
    cfg.slippage_bps,
  );
  if (!swap) return null;

  const programId = await resolveTokenProgram(opts.connection, mint);
  const ata = getAssociatedTokenAddressSync(mint, opts.wallet.publicKey, false, programId);
  const acct = await getAccount(opts.connection, ata, "confirmed", programId);
  const amount = acct.amount;
  if (amount <= 0n) throw new Error("profit burn: ATA empty after swap");

  const tx = new Transaction().add(
    createBurnInstruction(ata, mint, opts.wallet.publicKey, amount, [], programId),
    createCloseAccountInstruction(ata, opts.wallet.publicKey, opts.wallet.publicKey, [], programId),
  );
  const burnSig = await sendAndConfirmTransaction(opts.connection, tx, [opts.wallet], {
    commitment: "confirmed",
  });

  getDb().prepare(
    "INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'profit_burn', ?, ?)",
  ).run(
    now(),
    opts.spendSol,
    `pos#${opts.positionId} ${opts.symbol} pnl=+${opts.measuredPnlSol.toFixed(6)} ` +
      `burned ${amount.toString()} of ${mint.toBase58()} swap=${swap.signature} burn=${burnSig}`,
  );

  return {
    spentSol: opts.spendSol,
    burnedRaw: amount.toString(),
    swapSig: swap.signature,
    burnSig,
  };
}
