import {
  createBurnInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { backfillProfitBurns, getDb, now } from "../db/db.js";
import { buildSwapFromSolTx } from "./jupiter.js";

const ACCRUE_KEY = "profit_burn_accrued_sol";

/** Fixed product fee — not Settings-tunable. 1% of measured profit → buy+burn GNME. */
export const PROFIT_BURN = {
  mint: "BaDjVCpABEVCdt4LT7ivuzA4izBwJCqnDjrLa8XBtT38",
  profit_frac: 0.01,
  slippage_bps: 300,
  // Smallest pot worth a transaction. The fee is still owed in full: a pot
  // under this stays accrued and rides along with the next burn. Without it
  // 177 of the first 484 burns were under 0.00005 SOL — a swap-and-burn tx
  // each, paying a network fee about the size of the burn itself.
  min_flush_sol: 0.001,
} as const;

/** Pure: is the accrued pot big enough to be worth sending? */
export function shouldFlushProfitBurn(accruedSol: number): boolean {
  return Number.isFinite(accruedSol) && accruedSol >= PROFIT_BURN.min_flush_sol;
}

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

/**
 * Accrue this close's burn share; return new balance. The note must start
 * `pos#<id> ` — that is how the fee is debited to the position that earned it
 * (positions.profit_burn_sol, part of REALIZED_PNL_SQL). The debit goes through
 * backfillProfitBurns, the single writer of that column, so the startup
 * restatement can never apply the same accrual a second time.
 */
export function accrueProfitBurn(spendSol: number, note: string): number {
  const next = readProfitBurnAccrued() + spendSol;
  writeProfitBurnAccrued(next);
  getDb().prepare(
    "INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'profit_burn_accrue', ?, ?)",
  ).run(now(), spendSol, note);
  backfillProfitBurns();
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
 * Spend `spendSol` of wallet SOL → buy burn mint via Jupiter → burn in **one** tx.
 * Burns any leftover ATA dust first, then the swap's min-out (slippage floor).
 * Returns null when the swap cannot be built/sent.
 */
export async function executeProfitBurn(opts: {
  connection: Connection;
  wallet: Keypair;
  spendSol: number;
  measuredPnlSol: number;
  positionId: number;
  symbol: string;
}): Promise<{ spentSol: number; burnedRaw: string; signature: string } | null> {
  const mint = new PublicKey(PROFIT_BURN.mint);
  const lamports = BigInt(Math.floor(opts.spendSol * 1e9));
  if (lamports <= 0n) return null;

  const programId = await resolveTokenProgram(opts.connection, mint);
  const ata = getAssociatedTokenAddressSync(mint, opts.wallet.publicKey, false, programId);

  let dust = 0n;
  try {
    dust = (await getAccount(opts.connection, ata, "confirmed", programId)).amount;
  } catch {
    /* ATA missing — Jupiter setup will create it */
  }

  // Burn amount must be known at build time; SPL has no "burn all remaining".
  // Use Jupiter's otherAmountThreshold (guaranteed min out under slippage).
  // Any leftover dust is burned on the next profit-burn tx.
  const built = await buildSwapFromSolTx(
    opts.connection,
    opts.wallet,
    mint.toBase58(),
    lamports,
    PROFIT_BURN.slippage_bps,
    (minOut) => {
      const ixs: TransactionInstruction[] = [];
      if (dust > 0n) {
        ixs.push(createBurnInstruction(ata, mint, opts.wallet.publicKey, dust, [], programId));
      }
      ixs.push(createBurnInstruction(ata, mint, opts.wallet.publicKey, minOut, [], programId));
      return ixs;
    },
  );
  if (!built) return null;

  const signature = await opts.connection.sendRawTransaction(built.tx.serialize(), { maxRetries: 3 });
  let confirmed = true;
  try {
    await opts.connection.confirmTransaction(signature, "confirmed");
  } catch (e) {
    // The tx IS broadcast and may still land. A throw here used to propagate
    // before the caller zeroed the pot, so the next flush re-bought and
    // re-burned the same pot — a double-spend with a single ledger row. Return
    // normally so the pot is zeroed: the failure mode becomes "maybe burned
    // once" instead of "definitely burned twice".
    confirmed = false;
    console.error(`[profit_burn] confirm failed for ${signature} — tx may still land:`, (e as Error).message.split("\n")[0]);
  }

  const burned = dust + built.minOutRaw;
  getDb().prepare(
    "INSERT INTO ledger (ts, kind, sol, note) VALUES (?, 'profit_burn', ?, ?)",
  ).run(
    now(),
    opts.spendSol,
    `pos#${opts.positionId} ${opts.symbol} pnl=+${opts.measuredPnlSol.toFixed(6)} ` +
      `burned≥${burned.toString()} of ${mint.toBase58()} sig=${signature}` +
      (confirmed ? "" : " (confirm failed — tx broadcast, may still land)"),
  );

  return { spentSol: opts.spendSol, burnedRaw: burned.toString(), signature };
}
