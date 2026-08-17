import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, SendTransactionError,
} from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import BN from "bn.js";
import { createRequire } from "node:module";
import type * as DLMMTypes from "@meteora-ag/dlmm";
import type { LbPosition } from "@meteora-ag/dlmm";
import { config, env, isLive, SOL_MINT } from "../config.js";
import { getDb, logError, now, upsertTokenMeta } from "../db/db.js";
import { alert } from "../alerts.js";
import { fetchPool } from "../scanner/meteora.js";
import type { ExitReason, Position } from "../types.js";
import type { Executor, OpenParams, PositionMark } from "./executor.js";
import { quoteToSolLamports, swapToSolEscalating } from "./jupiter.js";
import { zapToSolEscalating } from "./zap.js";
import {
  computeUnitLimitFor, computeUnitLimitIx, escalate, hasComputeUnitLimit,
  priorityFeeSettings, recentFeeMicroLamports, setComputeUnitPrice, writableAccountsOf,
} from "./priorityFee.js";
import { loadKeypair } from "./wallet.js";

// CJS require (see reconcile.ts): the SDK's ESM build crashes on anchor's
// CJS named exports under Node's loader; the CJS build has no such issue.
// The class is exported only as `default`, which TS's CJS interop mangles —
// so we type the surface we use structurally (verified against the .d.ts).
interface DlmmPool {
  tokenX: { mint: { decimals: number } };
  getActiveBin(): Promise<{ binId: number; price: string }>;
  getPositionsByUserAndLbPair(user: PublicKey): Promise<{
    activeBin: { binId: number; price: string };
    userPositions: LbPosition[];
  }>;
  initializePositionAndAddLiquidityByStrategy(params: {
    positionPubKey: PublicKey; user: PublicKey;
    totalXAmount: BN; totalYAmount: BN;
    strategy: { minBinId: number; maxBinId: number; strategyType: number };
    slippage?: number;
  }): Promise<Transaction>;
  removeLiquidity(params: {
    user: PublicKey; position: PublicKey; fromBinId: number; toBinId: number;
    bps: BN; shouldClaimAndClose?: boolean; skipUnwrapSOL?: boolean;
  }): Promise<Transaction[]>;
  closePositionIfEmpty(params: { owner: PublicKey; position: LbPosition }): Promise<Transaction>;
  claimAllSwapFee(params: { owner: PublicKey; positions: LbPosition[] }): Promise<Transaction[]>;
  refetchStates(): Promise<void>;
  fromPricePerLamport(pricePerLamport: number): string;
}
interface DlmmStatic {
  create(connection: Connection, dlmm: PublicKey): Promise<DlmmPool>;
}
const dlmmMod = createRequire(import.meta.url)("@meteora-ag/dlmm") as {
  default?: DlmmStatic;
  StrategyType: typeof DLMMTypes.StrategyType;
} & DlmmStatic;
const DLMM: DlmmStatic = dlmmMod.default ?? dlmmMod;
const StrategyType = dlmmMod.StrategyType;

// ============================================================================
// LIVE EXECUTOR — real funds. UNTESTED until the first funded shakedown run;
// begin with the smallest viable position sizes and watch every transaction.
//
// Design notes:
//  - One-sided SOL bid-ask: totalXAmount = 0, SOL on the Y side (all candidate
//    pools are X/SOL by the scanner's quote gate).
//  - Ranges wider than 69 bins split across multiple position accounts, SOL
//    allocated per chunk by the same linear bid-ask weighting the paper
//    executor simulates.
//  - Exits: removeLiquidity(100%, shouldClaimAndClose) then token→SOL via Zap
//    SDK (Jupiter V6) when use_zap=true, else manual Jupiter lite swap.
//  - exitSol / claim values are recorded from pre-close marks and quotes —
//    good ledger accuracy; exact fill audit belongs to the tx history.
// ============================================================================

const BINS_PER_ACCOUNT = 69;
// Longer than any healthy call and far shorter than a manager tick backlog.
const RPC_TIMEOUT_MS = 20_000;
// Rebuilds on ExceededBinSlippageTolerance — resending the same tx never helps
// (the active-bin check is baked into the instruction at build time).
export const OPEN_SLIPPAGE_REBUILDS = 2;

/** Planned top too far from on-chain active bin — refuse rather than strand capital. */
export function rangeGapTooLarge(plannedTop: number, activeBinId: number, maxGap = 150): boolean {
  return Math.abs(activeBinId - plannedTop) > maxGap;
}

/** Tracked accounts on chain returned none — never fabricate valueSol=0 / −open_cost. */
export function trackedButMissingOnChain(trackedCount: number, foundCount: number): boolean {
  return trackedCount > 0 && foundCount === 0;
}

/** Native SOL + wSOL ATA change for our wallet in one tx (Jupiter/zap often credit wSOL). */
export function wealthDeltaLamports(
  meta: NonNullable<ParsedTransactionWithMeta["meta"]>,
  accountKeys: Array<{ pubkey: PublicKey }>,
  wallet: PublicKey,
): number | null {
  const idx = accountKeys.findIndex((k) => k.pubkey.equals(wallet));
  const pre = meta.preBalances[idx];
  const post = meta.postBalances[idx];
  if (idx < 0 || pre === undefined || post === undefined) return null;
  let lamports = post - pre;
  const owner = wallet.toBase58();
  const sumWsol = (balances: NonNullable<typeof meta.preTokenBalances>) =>
    balances
      .filter((b) => b.owner === owner && b.mint === SOL_MINT)
      .reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
  lamports += sumWsol(meta.postTokenBalances ?? []) - sumWsol(meta.preTokenBalances ?? []);
  return lamports;
}

function lbPositionEmpty(p: LbPosition): boolean {
  return Number(p.positionData.totalXAmount) === 0 && Number(p.positionData.totalYAmount) === 0
    && Number(p.positionData.feeX.toString()) === 0 && Number(p.positionData.feeY.toString()) === 0;
}

/** Slippage sims need a rebuild, not a blind resend of the same instruction. */
export function shouldRebuildOpenOnSlippage(
  code: string | null,
  attempt: number,
  maxRebuilds = OPEN_SLIPPAGE_REBUILDS,
): boolean {
  return code === "ExceededBinSlippageTolerance" && attempt < maxRebuilds;
}

/** Pull the Anchor/program reason out of a Solana SendTransactionError. */
export function txErrorDetail(e: unknown): { summary: string; code: string | null; logs: string[] } {
  const err = e as Error & {
    logs?: string[];
    transactionLogs?: string[];
    transactionMessage?: string;
  };
  const logs = (Array.isArray(err.logs) ? err.logs : null)
    ?? (Array.isArray(err.transactionLogs) ? err.transactionLogs : null)
    ?? [];
  const blob = `${err.message ?? ""}\n${err.transactionMessage ?? ""}\n${logs.join("\n")}`;
  const named = /Error Code: ([A-Za-z]+)/.exec(blob)?.[1]
    ?? (/ExceededBinSlippageTolerance/.test(blob) ? "ExceededBinSlippageTolerance" : null)
    ?? (/InsufficientFunds/.test(blob) ? "InsufficientFunds" : null);
  const hex = /custom program error: (0x[0-9a-fA-F]+)/i.exec(blob)?.[1]?.toLowerCase() ?? null;
  // 0x1774 = 6004 = ExceededBinSlippageTolerance (lb_clmm)
  const fromHex = hex === "0x1774" || /Custom":6004/.test(blob) ? "ExceededBinSlippageTolerance" : null;
  const code = named ?? fromHex ?? hex;
  const interesting = logs
    .filter((l) => /Error|failed|AnchorError|Exceeded|Insufficient|slippage/i.test(l))
    .slice(0, 8);
  const tip = interesting.find((l) => /Error Code:|Error:|Exceeded|Insufficient/i.test(l))
    ?? err.transactionMessage
    ?? err.message?.split("\n").find((l) => l && !/^Simulation failed\.?\s*$/i.test(l.trim()))
    ?? err.message?.split("\n")[0]
    ?? "tx failed";
  const summary = (code ? `${code} — ${tip}` : tip).replace(/\s+/g, " ").slice(0, 400);
  return { summary, code, logs: interesting };
}

export class LiveExecutor implements Executor {
  readonly mode = "live" as const;
  readonly connection: Connection;
  readonly wallet: Keypair;
  private pools = new Map<string, DlmmPool>();

  constructor() {
    if (!isLive()) {
      throw new Error(
        'live mode requires BOTH [exec].mode="live" in config.toml AND FARMER_MODE=live in the environment'
      );
    }
    this.wallet = loadKeypair(env().walletPrivateKey, env().walletKeypairPath);
    // Every other outbound HTTP client in src/ carries an explicit timeout;
    // this one did not, so a node that accepts the TCP connection and never
    // answers wedges the manager tick indefinitely — the one failure shape the
    // watchdog cannot help with, because the loop never gets to run it.
    this.connection = new Connection(env().rpcUrl, {
      commitment: "confirmed",
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
    });
    console.log(`[live] executor armed — wallet ${this.wallet.publicKey.toBase58()}`);
  }

  private async pool(address: string): Promise<DlmmPool> {
    let p = this.pools.get(address);
    if (!p) {
      p = await DLMM.create(this.connection, new PublicKey(address));
      this.pools.set(address, p);
    }
    return p;
  }

  /**
   * Net SOL the wallet actually gained (+) or spent (-) across a set of txs we
   * sent, summed from each confirmed tx's own pre/post balances — fees and
   * rent included, since those move the fee payer's balance too.
   *
   * Supersedes polling getBalance until it "moved off" a pre-read baseline:
   * that returns on the FIRST leg of a multi-tx operation. A close sends the
   * remove-liquidity tx and then the Jupiter zap-out, so the poll returned on
   * the rent refund ~1s before the swap credited, and the entire exit value
   * was dropped (Apu pos#11, LOUIE pos#12: +0.2253/+0.2385 SOL swaps missed,
   * reported as a 0.26 SOL loss each against a real ~0.03). Attributing to
   * exact signatures also makes the measurement immune to unrelated wallet
   * activity landing mid-operation.
   *
   * null = a tx never became fetchable, so callers record unknown, not a wrong
   * number (chrome pos#5: an RPC race once logged a false 0 delta).
   */
  private async walletDelta(signatures: string[]): Promise<number | null> {
    if (signatures.length === 0) return 0;
    let lamports = 0;
    for (const sig of signatures) {
      let tx: ParsedTransactionWithMeta | null = null;
      for (let i = 0; i < 6 && tx === null; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1000));
        tx = await this.connection
          .getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })
          .catch(() => null);
      }
      if (!tx?.meta) {
        console.error(`[live] walletDelta: tx ${sig} not retrievable — recording unknown`);
        return null;
      }
      // accountKeys carries address-lookup entries appended in the same order
      // as pre/postBalances, so Jupiter's versioned txs index correctly.
      // Include wSOL ATA delta: residual sweeps / zap often land value as wSOL
      // with ~0 native change (Niles #63 recorded recovered≈0 on a +0.60 wSOL sell).
      const d = wealthDeltaLamports(tx.meta, tx.transaction.message.accountKeys, this.wallet.publicKey);
      if (d === null) {
        console.error(`[live] walletDelta: wallet absent from tx ${sig} — recording unknown`);
        return null;
      }
      lamports += d;
    }
    return lamports / 1e9;
  }

  /**
   * Size the compute budget for a tx we are about to send.
   *
   * Both halves matter: a prioritization fee is price × REQUESTED limit, so an
   * unset limit means paying for the implicit 200k-per-instruction default. The
   * DLMM SDK already simulates and prepends its own limit — `computeUnitLimitFor`
   * returns null there, because a second one fails the transaction.
   */
  private async applyComputeBudget(tx: Transaction): Promise<number> {
    const s = priorityFeeSettings();
    const base = await recentFeeMicroLamports(this.connection, writableAccountsOf(tx), s);
    if (!hasComputeUnitLimit(tx)) {
      // Simulation needs a blockhash and fee payer; sendAndConfirmTransaction
      // would otherwise set them itself on the first attempt.
      if (!tx.recentBlockhash) {
        tx.recentBlockhash = (await this.connection.getLatestBlockhash("confirmed")).blockhash;
      }
      tx.feePayer ??= this.wallet.publicKey;
      const units = await computeUnitLimitFor(this.connection, tx, s);
      if (units != null) tx.instructions.unshift(computeUnitLimitIx(units));
    }
    setComputeUnitPrice(tx, base);
    return base;
  }

  /** Raise the priority price in place for retry `attempt` (0-based). */
  private reprice(tx: Transaction, base: number, attempt: number): void {
    const price = escalate(base, attempt, priorityFeeSettings());
    setComputeUnitPrice(tx, price);
    console.log(`[live] retry ${attempt}: priority fee → ${price} µLamports/CU`);
  }

  /**
   * Resolve what actually happened to a broadcast signature before any resend.
   * "landed" = confirmed ok; "failed" = confirmed with an on-chain error;
   * "expired" = its blockhash is dead and it never landed (safe to re-sign);
   * "unknown" = we cannot tell (RPC blind) — resending would risk a double.
   */
  private async signatureFate(sig: string, blockhash: string): Promise<"landed" | "failed" | "expired" | "unknown"> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const st = (await this.connection.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        return st.err ? "failed" : "landed";
      }
      const valid = await this.connection
        .isBlockhashValid(blockhash, { commitment: "confirmed" })
        .catch(() => null);
      if (valid && valid.value === false) {
        // Blockhash dead — one final status read closes the race where the tx
        // confirmed in the same slot window.
        const st2 = (await this.connection.getSignatureStatuses([sig]).catch(() => null))?.value?.[0];
        if (st2 && (st2.confirmationStatus === "confirmed" || st2.confirmationStatus === "finalized")) {
          return st2.err ? "failed" : "landed";
        }
        return "expired";
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
    return "unknown";
  }

  private async send(tx: Transaction, extraSigners: Keypair[] = []): Promise<string> {
    const baseFee = await this.applyComputeBudget(tx);
    const retries = config().exec.tx_retries;
    let lastErr: Error | null = null;
    for (let i = 0; i <= retries; i++) {
      // Escalate before re-sending: the retry path exists for "broadcast but
      // never confirmed", which is precisely what an underpriced fee produces.
      if (i > 0) this.reprice(tx, baseFee, i);
      try {
        return await sendAndConfirmTransaction(this.connection, tx, [this.wallet, ...extraSigners], {
          commitment: "confirmed",
          skipPreflight: false,
        });
      } catch (e) {
        lastErr = e as Error;
        const detail = txErrorDetail(e);
        console.error(`[live] tx attempt ${i + 1}/${retries + 1} failed: ${detail.summary}`);
        // Program simulation failures are baked into the instruction — resending
        // the same bytes cannot succeed. Let the caller rebuild (open) or abort.
        if (e instanceof SendTransactionError || detail.code) {
          const prog = detail.code != null
            || /Simulation failed|custom program error|AnchorError/i.test(detail.summary);
          if (prog) throw Object.assign(new Error(detail.summary), { logs: detail.logs, code: detail.code });
        }
        // Non-program failure after signing (confirm timeout, network error):
        // the tx may have reached the RPC and can land for another ~60-90s.
        // sendAndConfirmTransaction re-fetches a blockhash on the next attempt,
        // producing a DIFFERENT signature — so a blind retry can double-execute
        // (double-sell on closes, "account already in use" + an orphaned funded
        // position on opens) and the landed attempt's signature would never
        // reach walletDelta. Resolve the first attempt's fate before resending.
        const attemptSig = tx.signature ? bs58.encode(tx.signature) : null;
        const attemptBlockhash = tx.recentBlockhash;
        if (attemptSig && attemptBlockhash) {
          const fate = await this.signatureFate(attemptSig, attemptBlockhash);
          if (fate === "landed") {
            console.log(`[live] tx attempt ${i + 1} actually landed as ${attemptSig} — recovered, not resending`);
            return attemptSig;
          }
          if (fate === "failed") {
            throw Object.assign(new Error(`tx landed with on-chain error: ${detail.summary}`), { logs: detail.logs, code: detail.code });
          }
          if (fate === "unknown") {
            throw Object.assign(
              new Error(`tx fate unknown (RPC blind) — not resending to avoid a double: ${detail.summary}`),
              { maybeSig: attemptSig },
            );
          }
          // "expired": provably never landed — safe to re-sign and resend.
        }
      }
    }
    throw lastErr ?? new Error("tx failed");
  }

  /** Current wallet balance of a mint, raw units, across both token programs. */
  private async tokenBalanceRaw(mint: string): Promise<bigint> {
    let total = 0n;
    const TOKEN_PROGRAMS = [
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    ];
    for (const programId of TOKEN_PROGRAMS) {
      const accs = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId });
      for (const acc of accs.value) {
        const info = acc.account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
        if (info.mint === mint) total += BigInt(info.tokenAmount.amount);
      }
    }
    return total;
  }

  /** Token-side → SOL after remove/claim. Zap SDK first when enabled; manual Jupiter fallback. */
  private async tokenToSol(
    mint: string, amountRaw: bigint, slippageBps: number,
  ): Promise<{ signature: string } | null> {
    if (amountRaw <= 0n || mint === SOL_MINT) return null;
    const sendTx = (tx: Transaction) => this.send(tx);
    if (config().exec.use_zap) {
      try {
        const zap = await zapToSolEscalating(this.wallet, mint, amountRaw, slippageBps, sendTx);
        if (zap) return { signature: zap.signature };
      } catch (e) {
        // A fate-unknown send must NOT fall through to the manual swap: if the
        // zap actually landed, selling amountRaw again double-sells (or, on a
        // below-range close, records the real exit under a discarded sig).
        if ((e as { maybeSig?: string }).maybeSig) throw e;
        console.error("[live] zap path failed, falling back to manual jupiter:", (e as Error).message.split("\n")[0]);
      }
      // "Zap threw" is not "zap didn't execute" — send() may have recovered a
      // landed attempt on a later slippage tier, or a leg landed then a
      // follow-up errored. Re-read the wallet and only sell what is still there.
      const bal = await this.tokenBalanceRaw(mint).catch(() => null);
      if (bal !== null) {
        if (bal <= 0n) return null; // zap (or someone) already sold it all
        if (bal < amountRaw) amountRaw = bal;
      }
    }
    const manual = await swapToSolEscalating(this.connection, this.wallet, mint, amountRaw, slippageBps)
      .catch((e) => {
        console.error("[live] manual swap failed:", (e as Error).message.split("\n")[0]);
        return null;
      });
    return manual ? { signature: manual.signature } : null;
  }

  /**
   * Unwrap any wSOL sitting in our ATA back to native SOL. The zap SDK's swap
   * tx carries ONLY Jupiter's swapInstruction — no cleanup/unwrap — so every
   * zap-path exit landed its proceeds as wSOL that walletSol() (native only)
   * and the residual sweep (positions mints only) never saw again: a slow,
   * guaranteed leak of bankroll into an account nothing read. Best-effort.
   */
  private async unwrapWsol(): Promise<void> {
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT), this.wallet.publicKey);
      const bal = await this.connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
      if (!bal || BigInt(bal.value.amount) <= 0n) return;
      const tx = new Transaction().add(
        createCloseAccountInstruction(ata, this.wallet.publicKey, this.wallet.publicKey)
      );
      await this.send(tx);
      console.log(`[live] unwrapped ${(Number(bal.value.amount) / 1e9).toFixed(4)} wSOL back to native`);
    } catch (e) {
      console.error("[live] wSOL unwrap failed (will retry next close/sweep):", (e as Error).message.split("\n")[0]);
    }
  }

  /** Our stored on-chain position accounts for a DB position row. */
  private accountKeys(positionId: number): PublicKey[] {
    const rows = getDb().prepare(
      "SELECT pubkey FROM position_accounts WHERE position_id = ?"
    ).all(positionId) as Array<{ pubkey: string }>;
    return rows.map((r) => new PublicKey(r.pubkey));
  }

  // Takes only the two fields it reads, so open() can call it with a freshly
  // inserted row before a full Position object exists.
  private async ourLbPositions(position: { id: number; poolAddress: string }): Promise<{ active: number; priceYperX: number; positions: LbPosition[] }> {
    const pool = await this.pool(position.poolAddress);
    await pool.refetchStates();
    const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(this.wallet.publicKey);
    const ours = new Set(this.accountKeys(position.id).map((k) => k.toBase58()));
    const priceYperX = Number(pool.fromPricePerLamport(Number(activeBin.price)));
    const mine = userPositions.filter((p) => ours.has(p.publicKey.toBase58()));
    // An empty-but-successful read is the most expensive silent failure in this
    // codebase. getProgramAccounts returns `userPositions: []` without error
    // when a node is lagging or serving a stale snapshot (only a missing
    // activeBin throws in the SDK), the filter yields [], valueOf([]) returns
    // valueSol 0, and the P0 block reads that as `pool_dead` -> close at
    // safety slippage -> a terminal row with exit_sol 0 and close_return_sol 0.
    // REALIZED_PNL_SQL then turns that into -open_cost_sol, roughly -0.31 SOL:
    // past the circuit-breaker line and -1.0 into the Kelly window, for a
    // position that is still sitting on chain. Throwing converts it into an
    // ordinary mark failure the loop already counts, logs and survives.
    // Accepted tradeoff: a position genuinely closed out of band will now throw
    // every tick instead of self-closing. A noisy stuck row is recoverable at
    // the next boot's reconcile; an abandoned on-chain position plus a
    // fabricated loss in the risk inputs is not.
    if (trackedButMissingOnChain(ours.size, mine.length)) {
      throw new Error(
        `pos#${position.id}: ${ours.size} tracked position account(s) but the chain returned none — ` +
        `refusing to mark as worthless (stale/lagging RPC or missing position_accounts rows)`
      );
    }
    return { active: activeBin.binId, priceYperX, positions: mine };
  }

  /**
   * Per-bin composition of our position accounts, for RANGE-SHAPE-DECISION.md.
   * ~50 rows per position, so the fee-vs-depth and inventory-loss-vs-depth
   * curves are measurable at ~50x the sample rate of per-position PnL — which
   * is the whole reason the shape question is currently undecidable.
   * Zero-amount bins are KEPT on purpose: "this bin never converted" is the
   * observation the utilization question turns on. Keys are short because this
   * is stringified into events.detail_json.
   */
  private binSnapshot(positions: LbPosition[]): Array<Record<string, string | number>> {
    const out: Array<Record<string, string | number>> = [];
    for (const p of positions) {
      const bins = p.positionData?.positionBinData;
      if (!Array.isArray(bins)) continue;
      for (const b of bins) {
        if (!b || b.binId == null) continue;
        out.push({
          b: b.binId, p: b.price,
          x: b.positionXAmount, y: b.positionYAmount,
          fx: b.positionFeeXAmount, fy: b.positionFeeYAmount,
        });
      }
    }
    return out;
  }

  private valueOf(positions: LbPosition[], priceYperX: number, xDecimals: number): { valueSol: number; feesSol: number; feeXRaw: bigint } {
    let xRaw = 0, yRaw = 0, feeXRaw = 0n, feeYRaw = 0;
    for (const p of positions) {
      xRaw += Number(p.positionData.totalXAmount);
      yRaw += Number(p.positionData.totalYAmount);
      feeXRaw += BigInt(p.positionData.feeX.toString());
      feeYRaw += Number(p.positionData.feeY.toString());
    }
    const xUi = xRaw / 10 ** xDecimals;
    const feeXUi = Number(feeXRaw) / 10 ** xDecimals;
    const valueSol = yRaw / 1e9 + xUi * priceYperX;
    const feesSol = feeYRaw / 1e9 + feeXUi * priceYperX;
    return { valueSol: valueSol + feesSol, feesSol, feeXRaw };
  }

  async open(params: OpenParams): Promise<Position> {
    const pool = await this.pool(params.poolAddress);
    const activeBin = await pool.getActiveBin();
    const shape = params.range.shape ?? "bidask";
    const meta = await fetchPool(params.poolAddress);
    const binStep = meta?.binStep ?? 100;

    let maxBin: number, minBin: number;
    if (shape === "spot") {
      const mj = config().majors;
      const below = Math.max(1, Math.round(mj.range_below_pct / (binStep / 100)));
      const above = Math.max(0, Math.round(mj.range_above_pct / (binStep / 100)));
      maxBin = activeBin.binId + above;
      minBin = activeBin.binId - below;
      const maxBins = BINS_PER_ACCOUNT * config().entry.max_position_accounts;
      if (maxBin - minBin + 1 > maxBins) minBin = maxBin - maxBins + 1;
    } else {
      if (rangeGapTooLarge(params.range.maxBinId, activeBin.binId)) {
        const gap = Math.abs(activeBin.binId - params.range.maxBinId);
        throw new Error(
          `range sanity: planned top bin ${params.range.maxBinId} is ${gap} bins from on-chain active ${activeBin.binId} — refusing to open`
        );
      }
      const width = params.range.maxBinId - params.range.minBinId;
      maxBin = activeBin.binId;
      minBin = activeBin.binId > params.range.maxBinId
        ? maxBin - width
        : Math.min(params.range.minBinId, maxBin - 1);
    }
    const totalBins = maxBin - minBin + 1;
    if (shape !== "spot") {
      // Re-anchor sanity: when the on-chain price has dumped THROUGH the
      // planned depth between planning and open, the min(plannedMin, maxBin-1)
      // clamp above collapses a ~50-bin ladder into 2 bins holding full size —
      // a max-size buy wall directly under a crashing (plausibly rugging)
      // price. The 150-bin gap check only guards the other direction.
      const plannedBins = params.range.maxBinId - params.range.minBinId + 1;
      if (totalBins < Math.max(10, Math.ceil(plannedBins * 0.5))) {
        throw new Error(
          `range sanity: re-anchored range is ${totalBins} bins vs ${plannedBins} planned — ` +
          `price fell through the planned depth between planning and open; refusing to open`
        );
      }
    }
    let liveEntryPrice = Number(pool.fromPricePerLamport(Number(activeBin.price)));
    const lamports = Math.floor(params.sizeSol * 1e9);
    const strategyType = shape === "spot" ? StrategyType.Spot : StrategyType.BidAsk;

    const chunks: Array<{ min: number; max: number; share: number }> = [];
    const totalWRamp = (totalBins * (totalBins + 1)) / 2;
    for (let start = 0; start < totalBins; start += BINS_PER_ACCOUNT) {
      const end = Math.min(start + BINS_PER_ACCOUNT - 1, totalBins - 1);
      let share: number;
      if (shape === "spot") share = (end - start + 1) / totalBins;
      else {
        let w = 0;
        for (let i = start; i <= end; i++) w += i + 1;
        share = w / totalWRamp;
      }
      chunks.push({ min: maxBin - end, max: maxBin - start, share });
    }

    const accountRows: Array<{ pubkey: string; min: number; max: number }> = [];
    const sigs: string[] = [];
    // Width preserved across rebuilds; top always re-anchors to live active bin.
    let curMin = minBin;
    let curMax = maxBin;
    let curPrice = liveEntryPrice;
    for (let ci = 0; ci < chunks.length; ci++) {
      let chunk = chunks[ci]!;
      let opened = false;
      let lastDetail: ReturnType<typeof txErrorDetail> | null = null;
      for (let attempt = 0; attempt <= OPEN_SLIPPAGE_REBUILDS; attempt++) {
        if (attempt > 0) {
          await pool.refetchStates();
          // Only re-anchor when nothing is on chain yet. A later chunk failing
          // after an earlier one landed must keep the same bin window.
          if (accountRows.length === 0) {
            const fresh = await pool.getActiveBin();
            const widthBins = curMax - curMin;
            curMax = fresh.binId;
            curMin = curMax - widthBins;
            const total = curMax - curMin + 1;
            const start = ci * BINS_PER_ACCOUNT;
            const end = Math.min(start + BINS_PER_ACCOUNT - 1, total - 1);
            chunk = { min: curMax - end, max: curMax - start, share: chunk.share };
            curPrice = Number(pool.fromPricePerLamport(Number(fresh.price)));
            console.warn(
              `[live] rebuild open after ${lastDetail?.code ?? "slippage"} — ` +
              `active=${fresh.binId} bins=[${chunk.min},${chunk.max}]`
            );
          } else {
            console.warn(
              `[live] rebuild chunk ${ci} after ${lastDetail?.code ?? "slippage"} — ` +
              `keeping bins=[${chunk.min},${chunk.max}]`
            );
          }
        }
        const positionKp = Keypair.generate();
        try {
          const tx = await pool.initializePositionAndAddLiquidityByStrategy({
            positionPubKey: positionKp.publicKey,
            user: this.wallet.publicKey,
            totalXAmount: new BN(0),
            totalYAmount: new BN(Math.floor(lamports * chunk.share)),
            strategy: { minBinId: chunk.min, maxBinId: chunk.max, strategyType },
            slippage: config().entry.liquidity_slippage_pct,
          });
          const sig = await this.send(tx, [positionKp]);
          sigs.push(sig);
          accountRows.push({ pubkey: positionKp.publicKey.toBase58(), min: chunk.min, max: chunk.max });
          console.log(`[live] opened position account ${positionKp.publicKey.toBase58()} bins [${chunk.min},${chunk.max}] tx ${sig}`);
          opened = true;
          break;
        } catch (e) {
          lastDetail = txErrorDetail(e);
          if (shouldRebuildOpenOnSlippage(lastDetail.code, attempt)) continue;
          throw Object.assign(new Error(lastDetail.summary), { logs: lastDetail.logs, code: lastDetail.code });
        }
      }
      if (!opened) throw new Error(lastDetail?.summary ?? "open failed");
    }
    minBin = curMin;
    maxBin = curMax;
    liveEntryPrice = curPrice;

    // Actual wallet debit for this open (size + all rents + tx fees) — the
    // truth for per-position PnL, unlike the estBinRentSol estimate. Summed
    // per-tx: a multi-chunk open sends one tx per position account, and a
    // baseline poll settles after the first (RUBY pos#8 recorded 0.3029 for a
    // 0.45 SOL entry that way).
    const delta = await this.walletDelta(sigs);
    const openCostSol = delta === null ? null : -delta;

    const db = getDb();
    const res = db.prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, tranche_of, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, rent_paid_sol, open_cost_sol)
       VALUES ('live', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    ).run(
      params.poolAddress, params.tokenMint, params.symbol, params.trancheOf ?? null,
      now(), liveEntryPrice, params.sizeSol, minBin, maxBin, params.range.estBinRentSol, openCostSol
    );
    const id = Number(res.lastInsertRowid);
    for (const a of accountRows)
      db.prepare("INSERT INTO position_accounts (position_id, pubkey, min_bin_id, max_bin_id) VALUES (?, ?, ?, ?)")
        .run(id, a.pubkey, a.min, a.max);
    upsertTokenMeta(params.tokenMint, { symbol: params.symbol });

    // Open event. Two things that did not survive before: the open signatures
    // (only close sigs reached events, which is why reconstructing the book
    // needed a 205k-signature wallet scan) and the DEPOSITED per-bin
    // composition. The latter is y_deposited(d) — the denominator of the
    // inventory-loss curve, and not recoverable later once bins have traded.
    // One extra RPC after the tx has already confirmed, so it cannot affect
    // the fill; failure here must never orphan a position that is open on
    // chain, hence the catch.
    let openBins: Array<Record<string, string | number>> | null = null;
    try {
      const { positions: fresh } = await this.ourLbPositions({ id, poolAddress: params.poolAddress });
      openBins = this.binSnapshot(fresh);
    } catch (e) {
      console.error("[live] open bin snapshot failed (position is fine):", (e as Error).message.split("\n")[0]);
    }
    db.prepare(
      "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, tx_cost_sol, detail_json) VALUES (?, ?, 'open', ?, ?, ?, ?)"
    ).run(id, now(), sigs[0] ?? null, openCostSol === null ? null : -openCostSol, 0.0005 * sigs.length,
      JSON.stringify({ sigs, openCostSol, sizeSol: params.sizeSol, minBin, maxBin, bins: openBins }));

    return {
      id, mode: "live", poolAddress: params.poolAddress, tokenMint: params.tokenMint,
      symbol: params.symbol, trancheOf: params.trancheOf ?? null, entryTs: now(),
      entryPrice: liveEntryPrice, entrySol: params.sizeSol, minBinId: minBin,
      maxBinId: maxBin, state: "open", feesClaimedSol: 0,
      rentPaidSol: params.range.estBinRentSol, profitLockFires: 0,
      exitTs: null, exitSol: null, exitReason: null,
    };
  }

  async mark(position: Position): Promise<PositionMark> {
    const pool = await this.pool(position.poolAddress);
    const { active, priceYperX, positions } = await this.ourLbPositions(position);
    const xDecimals = pool.tokenX.mint.decimals;
    const { valueSol, feesSol } = this.valueOf(positions, priceYperX, xDecimals);
    const aboveRange = active > position.maxBinId;
    const belowRange = active < position.minBinId;
    // Pool health from datapi (TVL / fee rate / volume for P0 & P2).
    const dp = await fetchPool(position.poolAddress).catch(() => null);
    return {
      valueSol,
      unclaimedFeesSol: feesSol,
      activeBinId: active,
      price: priceYperX,
      inRange: !aboveRange && !belowRange,
      aboveRange, belowRange,
      tvlUsd: dp?.tvlUsd ?? 0,
      feeTvl30mPct: dp?.feeTvl30mPct ?? 0,
      vol30mUsd: dp?.vol30mUsd ?? 0,
      poolAgeS: dp?.createdAt ? Math.max(0, (Date.now() - Date.parse(dp.createdAt)) / 1000) : null,
    };
  }

  async claimFees(position: Position): Promise<{ claimedSol: number; txCostSol: number }> {
    const pool = await this.pool(position.poolAddress);
    const { priceYperX, positions } = await this.ourLbPositions(position);
    if (positions.length === 0) return { claimedSol: 0, txCostSol: 0 };
    const xDecimals = pool.tokenX.mint.decimals;
    const { feesSol, feeXRaw } = this.valueOf(positions, priceYperX, xDecimals);
    // Bins before the claim resets the fee accumulators — this is the only
    // moment the per-bin fee split is observable (RANGE-SHAPE-DECISION.md).
    const claimBins = this.binSnapshot(positions);

    const sigs: string[] = [];
    const txs = await pool.claimAllSwapFee({ owner: this.wallet.publicKey, positions });
    for (const tx of txs) sigs.push(await this.send(tx));

    // Bank policy: token-side fees -> SOL immediately (§4 P4).
    if (feeXRaw > 0n) {
      const swap = await this.tokenToSol(position.tokenMint, feeXRaw, config().exec.exit_slippage_bps);
      if (swap) sigs.push(swap.signature);
    }

    // `feesSol` values the token side at pool mid; the swap fills below that,
    // or fails and strands it (measured ran 32% under marked across the first
    // four claims). Record both: the mark for continuity, the measured credit
    // for anything that wants the truth.
    const measured = await this.walletDelta(sigs);
    const db = getDb();
    db.prepare(
      "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, tx_cost_sol, detail_json) VALUES (?, ?, 'claim', ?, ?, ?, ?)"
    ).run(
      position.id, now(), sigs[0] ?? null, feesSol, 0.0005 * txs.length,
      JSON.stringify({ sigs, markedSol: feesSol, measuredSol: measured, feeXRaw: feeXRaw.toString(), bins: claimBins })
    );
    // measured ?? feesSol, not ?? 0: a null walletDelta means the measurement
    // failed, not that the claim was worth nothing — recording 0 permanently
    // erased that claim's income from realized PnL. The marked value runs hot
    // vs measured (~23% book-wide) but is far closer to truth than zero.
    db.prepare(
      "UPDATE positions SET fees_claimed_sol = fees_claimed_sol + ?, fees_measured_sol = fees_measured_sol + ? WHERE id = ?"
    ).run(feesSol, measured ?? feesSol, position.id);
    return { claimedSol: feesSol, txCostSol: 0.0005 * txs.length };
  }

  async withdraw(position: Position, bps: number): Promise<{ withdrawnSol: number; txCostSol: number }> {
    const pool = await this.pool(position.poolAddress);
    const { priceYperX, positions } = await this.ourLbPositions(position);
    const xDecimals = pool.tokenX.mint.decimals;
    const before = this.valueOf(positions, priceYperX, xDecimals);
    let xToSwap = 0n;
    for (const p of positions) {
      xToSwap += BigInt(Math.floor(Number(p.positionData.totalXAmount) * bps / 10_000));
    }

    const sigs: string[] = [];
    for (const p of positions) {
      const txs = await pool.removeLiquidity({
        user: this.wallet.publicKey,
        position: p.publicKey,
        fromBinId: p.positionData.lowerBinId,
        toBinId: p.positionData.upperBinId,
        bps: new BN(bps),
        shouldClaimAndClose: false,
      });
      for (const tx of txs) sigs.push(await this.send(tx));
    }
    if (xToSwap > 0n) {
      // Clamp to what the removes actually delivered: on-chain removal floors
      // per bin, so the wallet receives up to ~1 raw unit less per bin than the
      // pre-remove estimate — and a Jupiter exact-in swap for more than the
      // balance fails at every slippage tier, stranding the whole token side.
      const delivered = await this.tokenBalanceRaw(position.tokenMint).catch(() => null);
      if (delivered !== null && delivered < xToSwap) xToSwap = delivered;
      if (xToSwap > 0n) {
        const swap = await this.tokenToSol(position.tokenMint, xToSwap, config().exec.exit_slippage_bps);
        if (swap) sigs.push(swap.signature);
      }
    }

    const withdrawn = (before.valueSol - before.feesSol) * (bps / 10_000);
    const measured = sigs.length ? await this.walletDelta(sigs) : null;
    const db = getDb();
    db.prepare("INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol, detail_json) VALUES (?, ?, 'profit_lock', ?, ?, ?)")
      .run(position.id, now(), withdrawn, 0.001, JSON.stringify({ bps, xToSwapRaw: xToSwap.toString(), measuredSol: measured, sigs }));
    // withdrawn_sol: the locked SOL is realized PnL the moment it lands in the
    // wallet; REALIZED_PNL_SQL adds it back at close against the unshrunk
    // open_cost_sol basis. Without it a locked winner read as a loss.
    db.prepare("UPDATE positions SET entry_sol = entry_sol * (1 - ? / 10000.0), profit_lock_fires = profit_lock_fires + 1, withdrawn_sol = withdrawn_sol + ? WHERE id = ?")
      .run(bps, Math.max(0, measured ?? withdrawn), position.id);
    return { withdrawnSol: measured ?? withdrawn, txCostSol: 0.001 };
  }

  async escapeRebalance(_position: Position, _slippageBps: number): Promise<{ ok: boolean }> {
    // Disabled: Zap reshape reported success on BOB/Niles while zap-in left an empty
    // shell (−100% until residual sweep). Escape hatch always closes instead.
    return { ok: false };
  }

  async close(position: Position, reason: ExitReason, slippageBps: number): Promise<{ exitSol: number; txCostSol: number }> {
    const pool = await this.pool(position.poolAddress);
    const { priceYperX, positions } = await this.ourLbPositions(position);
    const xDecimals = pool.tokenX.mint.decimals;
    const before = this.valueOf(positions, priceYperX, xDecimals);
    // Snapshot bins BEFORE removeLiquidity — afterwards the accounts are closed
    // and the composition is gone for good.
    const closeBins = this.binSnapshot(positions);

    // Every tx this close sends, so the wallet delta below covers all of them.
    const sigs: string[] = [];
    let xToSwap = 0n;
    let removeFailedEmpty = false;
    for (const p of positions) {
      xToSwap += BigInt(Math.floor(Number(p.positionData.totalXAmount))) + BigInt(p.positionData.feeX.toString());
      // Failed escape-rebalance can leave an empty on-chain account. removeLiquidity
      // then crashes inside the SDK (binId undefined). Close the shell for rent.
      if (lbPositionEmpty(p) || before.valueSol <= 1e-9) {
        try {
          const tx = await pool.closePositionIfEmpty({ owner: this.wallet.publicKey, position: p });
          sigs.push(await this.send(tx));
        } catch (e) {
          removeFailedEmpty = true;
          console.error(
            `[live] pos#${position.id}: closePositionIfEmpty failed:`,
            (e as Error).message.split("\n")[0],
          );
        }
        continue;
      }
      const fromBinId = p.positionData.lowerBinId ?? position.minBinId;
      const toBinId = p.positionData.upperBinId ?? position.maxBinId;
      try {
        const txs = await pool.removeLiquidity({
          user: this.wallet.publicKey,
          position: p.publicKey,
          fromBinId,
          toBinId,
          bps: new BN(10_000),
          shouldClaimAndClose: true,
        });
        for (const tx of txs) sigs.push(await this.send(tx));
      } catch (e) {
        if (before.valueSol > 1e-9) throw e;
        try {
          const tx = await pool.closePositionIfEmpty({ owner: this.wallet.publicKey, position: p });
          sigs.push(await this.send(tx));
        } catch (e2) {
          removeFailedEmpty = true;
          console.error(
            `[live] pos#${position.id}: empty removeLiquidity+close failed — writing terminal exit:`,
            (e2 as Error).message.split("\n")[0],
          );
        }
      }
    }

    // Manual zap-out: swap all withdrawn token-side to SOL. On a below-range
    // exit this leg IS the exit value — the remove-liquidity tx returns only
    // rent — so its signature must reach the delta or the close reads as a
    // total loss.
    // Also sell any wallet residue of this mint (escape rebalance can leave
    // tokens in the ATA while position bins are empty — xToSwap from chain is 0).
    let walletX = 0n;
    let walletXKnown = false;
    try {
      walletX = await this.tokenBalanceRaw(position.tokenMint);
      walletXKnown = true;
    } catch (e) {
      console.error(`[live] pos#${position.id}: wallet residue check failed:`, (e as Error).message.split("\n")[0]);
    }
    // The wallet balance is the sellable truth when we could read it: the old
    // max(xToSwap, walletX) turned any chain-side OVERestimate (per-bin
    // flooring, Token-2022 transfer-fee mints delivering less than
    // totalXAmount) into an exact-in swap for more than we hold — which fails
    // every slippage tier on exactly the below-range closes where the swap IS
    // the exit value. xToSwap remains the fallback for a blind RPC read.
    const toSell = walletXKnown ? walletX : xToSwap;
    if (toSell > 0n) {
      const swap = await this.tokenToSol(position.tokenMint, toSell, slippageBps);
      if (swap) sigs.push(swap.signature);
    }

    // Never write terminal state for a close that sent nothing — unless the
    // position is already empty on-chain (failed rebalance) and removeLiquidity
    // cannot run. In that case exit_sol=0 is the truth, not a fabricated loss.
    if (sigs.length === 0 && this.accountKeys(position.id).length > 0 && !removeFailedEmpty) {
      throw new Error(
        `pos#${position.id}: close sent no transactions against ${this.accountKeys(position.id).length} ` +
        `tracked account(s) — refusing to write an exit`
      );
    }

    const stateByReason: Record<ExitReason, string> = {
      P0_safety: "closed_safety", P1_stop: "closed_stop", P2_rotation: "closed_rotation",
      P3_above: "closed_win", P5_below: "closed_below", escape: "closed_escape", manual: "closed_manual",
    };
    // Actual wallet credit for this close (exit value + rent refunds - tx fees).
    const closeReturnSol = sigs.length ? await this.walletDelta(sigs) : 0;

    // A close that leaves the token side in the wallet is NOT closed — it is a
    // position we stopped watching. 4680 pos#97 on the server bot (2026-08-16):
    // the P1 exit removed liquidity and the swap "succeeded" but returned 0.065
    // SOL against a 0.198 mark; ~70% of the tokens sat unsold in the wallet for
    // ten minutes until the residual sweep found them. It happened to sell them
    // +60% higher and turned a loss into a profit — the same shape on a token
    // that KEPT falling would have been a -25% stop silently held to -60%. The
    // sweep will pick it up, but the operator must know at close time, not
    // discover it in the ledger. Best-effort read; never blocks the close.
    let leftoverTokenSol: number | null = null;
    if (xToSwap > 0n && position.tokenMint !== SOL_MINT) {
      try {
        const leftRaw = await this.tokenBalanceRaw(position.tokenMint);
        if (leftRaw > 0n) {
          const q = await quoteToSolLamports(position.tokenMint, leftRaw);
          leftoverTokenSol = q === null ? null : q / 1e9;
          const share = before.valueSol > 0 && leftoverTokenSol !== null ? leftoverTokenSol / before.valueSol : null;
          const msg = `[live] pos#${position.id} ${position.symbol}: close left ${leftRaw} raw tokens in wallet` +
            (leftoverTokenSol !== null ? ` (~${leftoverTokenSol.toFixed(4)} SOL, ${share !== null ? (share * 100).toFixed(0) + "% of mark" : "?"})` : "") +
            ` — swap under-filled; residual sweep will sell it. Position is NOT fully out.`;
          console.error(msg);
          logError({
            source: "live", code: "close_underfilled", message: msg,
            detail: { positionId: position.id, leftRaw: leftRaw.toString(), leftoverTokenSol, markedExitSol: before.valueSol, closeReturnSol },
            symbol: position.symbol, mint: position.tokenMint, pool: position.poolAddress, dedupeSec: 60,
          });
          if (share !== null && share >= 0.25) {
            await alert("watchdog",
              `⚠️ ${position.symbol} pos#${position.id}: exit swap under-filled — ~${leftoverTokenSol!.toFixed(3)} SOL of tokens ` +
              `(${(share * 100).toFixed(0)}% of the position) still in wallet. Sweep will retry; not fully out yet.`
            ).catch(() => {});
          }
        }
      } catch { /* diagnostic only */ }
    }

    const db = getDb();
    // `before.feesSol` is what shouldClaimAndClose collected on the way out.
    // It is already inside closeReturnSol; recorded separately so fee income is
    // attributable at all (see the fees_at_close_sol migration note in db.ts).
    // stranded_sol carries the leftovers as an asset until the sweep sells them
    // — without it every realized-PnL consumer (circuit breaker, cluster brake,
    // close alert, Kelly, dashboard) reads the under-fill as a total loss for up
    // to a sweep interval. See STRANDED_GRACE_S in db.ts for why it expires.
    db.prepare(
      "UPDATE positions SET state = ?, exit_ts = ?, exit_sol = ?, exit_reason = ?, close_return_sol = ?, fees_at_close_sol = ?," +
      " stranded_sol = ?, stranded_at = ? WHERE id = ?"
    // NOT NULL column: better-sqlite3 binds NaN as NULL, and this UPDATE runs
    // AFTER removeLiquidity and the zap-out have irreversibly landed. A throw
    // here would leave state='open' on a position with nothing on chain, which
    // the next tick reads as valueSol 0 and writes off as a total loss.
    ).run(
      stateByReason[reason], now(), before.valueSol, reason, closeReturnSol,
      Number.isFinite(before.feesSol) ? before.feesSol : 0,
      // Only a quoted leftover counts. An unquotable one (null) is exactly the
      // case where we cannot claim it is worth anything, so it stays a loss.
      leftoverTokenSol != null && Number.isFinite(leftoverTokenSol) && leftoverTokenSol > 0 ? leftoverTokenSol : 0,
      leftoverTokenSol != null && Number.isFinite(leftoverTokenSol) && leftoverTokenSol > 0 ? now() : null,
      position.id
    );
    // Record the exact signatures the delta was summed from: without them a
    // disputed close can only be reconstructed by scanning wallet history.
    db.prepare(
      "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, tx_cost_sol, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      position.id, now(), reason === "P0_safety" ? "safety_exit" : "withdraw",
      sigs[0] ?? null, before.valueSol, 0.001,
      JSON.stringify({
        sigs, closeReturnSol, markedExitSol: before.valueSol, swapped: xToSwap > 0n,
        leftoverTokenSol,
        emptyClose: removeFailedEmpty || before.valueSol <= 1e-9,
        // Chain legs, so attribution reconciles without a wallet scan
        // (RANGE-SHAPE-DECISION.md item 3).
        legs: { feesSolMarked: before.feesSol, feeXRaw: before.feeXRaw.toString(), xToSwapRaw: xToSwap.toString() },
        // Per-bin composition at exit. Paired with the 'open' event's bins this
        // gives y_deposited(d) and (y(d), x(d)) per bin — both sides of
        // L(d) = y_deposited(d) - (y(d) + x(d) * p_exit).
        bins: closeBins,
      })
    );
    // Hygiene, after all accounting is written: zap-path proceeds land as wSOL
    // (wealth-neutral for the delta above, invisible to walletSol/bankroll).
    await this.unwrapWsol();
    return { exitSol: before.valueSol, txCostSol: 0.001 };
  }

  async walletSol(): Promise<number> {
    return (await this.connection.getBalance(this.wallet.publicKey)) / 1e9;
  }

  async healthProbe(): Promise<number> {
    return this.connection.getSlot();
  }

  /**
   * Read-only: how many of a position's tracked accounts still exist on chain.
   * Deliberately does NOT go through ourLbPositions, whose whole job is to
   * throw on exactly the tracked>0 / found==0 case — which is the case
   * `npm run force-close` needs to observe rather than be protected from.
   */
  async chainPresence(position: { id: number; poolAddress: string }): Promise<{ tracked: number; found: number }> {
    const pool = await this.pool(position.poolAddress);
    await pool.refetchStates();
    const { userPositions } = await pool.getPositionsByUserAndLbPair(this.wallet.publicKey);
    const ours = new Set(this.accountKeys(position.id).map((k) => k.toBase58()));
    return { tracked: ours.size, found: userPositions.filter((p) => ours.has(p.publicKey.toBase58())).length };
  }

  /**
   * Sell any wallet balance of a mint the bot has ever traded. Close/claim
   * zap-outs are best-effort — a failed swap strands tokens in the wallet with
   * nothing else ever looking at them again. Runs from the manager loop (same
   * single-threaded tick as closes, so it cannot race an in-flight exit).
   * Unknown mints (airdrop spam) are never touched; dust below `minSol` is
   * left alone so tx fees don't eat the proceeds.
   */
  async sweepResiduals(minSol: number): Promise<Array<{ mint: string; symbol: string; soldSol: number; positionId: number | null }>> {
    const db = getDb();
    const known = new Set(
      (db.prepare("SELECT DISTINCT token_mint FROM positions").all() as Array<{ token_mint: string }>)
        .map((r) => r.token_mint)
    );
    const recovered: Array<{ mint: string; symbol: string; soldSol: number; positionId: number | null }> = [];
    const closable: Array<{ pubkey: PublicKey; programId: PublicKey; mint: string; symbol: string }> = [];
    await this.unwrapWsol(); // wSOL is a residual too — see unwrapWsol

    const TOKEN_PROGRAMS = [
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    ];
    const symFor = (mint: string) => {
      const owner = db.prepare(
        "SELECT id, symbol FROM positions WHERE token_mint = ? ORDER BY id DESC LIMIT 1"
      ).get(mint) as { id: number; symbol: string } | undefined;
      return { owner, symbol: owner?.symbol ?? mint.slice(0, 8) };
    };
    for (const programId of TOKEN_PROGRAMS) {
      const accs = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId });
      for (const acc of accs.value) {
        const info = acc.account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
        if (!known.has(info.mint)) continue;
        // An emptied account still holds its 0.00204 SOL of rent, and nothing
        // in this codebase ever reclaimed it. The signature is exact in our own
        // ledger: a flat round trip on a NEW mint measured -0.00212 (Bark pos#13,
        // entry price == exit price) while a flat round trip reusing an existing
        // account measured -0.00005 (BUTTHOLE pos#20). The rent WAS the loss.
        if (info.tokenAmount.amount === "0") {
          if (this.mintIsIdle(info.mint)) {
            const { symbol } = symFor(info.mint);
            closable.push({ pubkey: acc.pubkey, programId, mint: info.mint, symbol });
          }
          continue;
        }
        const raw = BigInt(info.tokenAmount.amount);
        const quoted = await quoteToSolLamports(info.mint, raw);
        if (quoted === null || quoted < minSol * 1e9) continue;
        const { owner, symbol } = symFor(info.mint);
        try {
          const res = await this.tokenToSol(info.mint, raw, config().exec.exit_slippage_bps);
          if (!res) continue;
          const soldSol = (await this.walletDelta([res.signature])) ?? 0;
          if (owner) {
            // Clearing stranded_sol as recovered_sol is credited is what keeps
            // the estimate and the measurement from ever being counted together.
            db.prepare(
              "UPDATE positions SET recovered_sol = recovered_sol + ?, stranded_sol = 0, stranded_at = NULL WHERE id = ?"
            ).run(soldSol, owner.id);
          }
          recovered.push({ mint: info.mint, symbol, soldSol, positionId: owner?.id ?? null });
        } catch (e) {
          console.error(`[live] residual sweep ${symbol} failed:`, (e as Error).message.split("\n")[0]);
        }
      }
    }
    if (closable.length) await this.closeEmptyAccounts(closable);
    return recovered;
  }

  /**
   * Safe to close this mint's token account? Only when we hold no position in
   * it and have not entered it inside the re-entry window — otherwise the next
   * ladder rung just re-pays the rent we reclaimed, and churns a tx doing it.
   */
  private mintIsIdle(mint: string): boolean {
    const row = getDb().prepare(
      `SELECT COUNT(*) AS c FROM positions
       WHERE token_mint = ?
         AND (state IN ('pending','open','closing') OR entry_ts > ?)`
    ).get(mint, now() - config().manage.loss_reentry_cooldown_h * 3600) as { c: number };
    return row.c === 0;
  }

  /** Reclaim rent from emptied token accounts. Best-effort: never throws. */
  private async closeEmptyAccounts(
    accounts: Array<{ pubkey: PublicKey; programId: PublicKey; mint: string; symbol: string }>,
  ): Promise<void> {
    const BATCH = 12; // close ix are tiny, but leave room for the priority-fee ix
    for (let i = 0; i < accounts.length; i += BATCH) {
      const batch = accounts.slice(i, i + BATCH);
      const tx = new Transaction();
      for (const a of batch)
        tx.add(createCloseAccountInstruction(a.pubkey, this.wallet.publicKey, this.wallet.publicKey, [], a.programId));
      try {
        const sig = await this.send(tx);
        const delta = await this.walletDelta([sig]);
        const tokens = batch.map((a) => ({ mint: a.mint, symbol: a.symbol, account: a.pubkey.toBase58() }));
        const posId = batch.length === 1
          ? (getDb().prepare(
              "SELECT id FROM positions WHERE token_mint = ? ORDER BY id DESC LIMIT 1"
            ).get(batch[0]!.mint) as { id: number } | undefined)?.id ?? null
          : null;
        getDb().prepare(
          "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, detail_json) VALUES (?, ?, 'rent_reclaim', ?, ?, ?)"
        ).run(posId, now(), sig, delta ?? 0, JSON.stringify({
          accounts: tokens.map((t) => t.account),
          tokens,
        }));
        const syms = [...new Set(tokens.map((t) => t.symbol))].join(",");
        console.log(`[live] 🧹 reclaimed rent ${syms} (${batch.length} acct) — +${(delta ?? 0).toFixed(5)} SOL (tx ${sig})`);
      } catch (e) {
        console.error("[live] rent reclaim failed:", (e as Error).message.split("\n")[0]);
      }
    }
  }
}
