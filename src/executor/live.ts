import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import BN from "bn.js";
import { createRequire } from "node:module";
import type * as DLMMTypes from "@meteora-ag/dlmm";
import type { LbPosition } from "@meteora-ag/dlmm";
import { config, env, isLive } from "../config.js";
import { getDb, now } from "../db/db.js";
import { fetchPool } from "../scanner/meteora.js";
import type { ExitReason, Position } from "../types.js";
import type { Executor, OpenParams, PositionMark } from "./executor.js";
import { quoteToSolLamports, swapToSolEscalating } from "./jupiter.js";
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
//  - Exits: removeLiquidity(100%, shouldClaimAndClose) then Jupiter-swap any
//    token-side proceeds to SOL (manual zap; @meteora-ag/zap-sdk optional
//    upgrade later).
//  - exitSol / claim values are recorded from pre-close marks and quotes —
//    good ledger accuracy; exact fill audit belongs to the tx history.
// ============================================================================

const BINS_PER_ACCOUNT = 69;
// Longer than any healthy call and far shorter than a manager tick backlog.
const RPC_TIMEOUT_MS = 20_000;

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
      const idx = tx.transaction.message.accountKeys.findIndex((k) =>
        k.pubkey.equals(this.wallet.publicKey)
      );
      const pre = tx.meta.preBalances[idx];
      const post = tx.meta.postBalances[idx];
      if (idx < 0 || pre === undefined || post === undefined) {
        console.error(`[live] walletDelta: wallet absent from tx ${sig} — recording unknown`);
        return null;
      }
      lamports += post - pre;
    }
    return lamports / 1e9;
  }

  private async priorityFeeIx() {
    const fees = await this.connection.getRecentPrioritizationFees().catch(() => []);
    const nonzero = fees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    const median = nonzero.length ? nonzero[Math.floor(nonzero.length / 2)]! : 10_000;
    const microLamports = Math.min(Math.max(median, 10_000), 1_000_000); // floor 0.00001, cap 0.001 SOL/200k CU
    return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
  }

  private async send(tx: Transaction, extraSigners: Keypair[] = []): Promise<string> {
    tx.add(await this.priorityFeeIx());
    const retries = config().exec.tx_retries;
    let lastErr: Error | null = null;
    for (let i = 0; i <= retries; i++) {
      try {
        return await sendAndConfirmTransaction(this.connection, tx, [this.wallet, ...extraSigners], {
          commitment: "confirmed",
          skipPreflight: false,
        });
      } catch (e) {
        lastErr = e as Error;
        console.error(`[live] tx attempt ${i + 1}/${retries + 1} failed: ${lastErr.message}`);
      }
    }
    throw lastErr ?? new Error("tx failed");
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
    if (ours.size > 0 && mine.length === 0) {
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
    for (const p of positions)
      for (const b of p.positionData.positionBinData)
        out.push({
          b: b.binId, p: b.price,
          x: b.positionXAmount, y: b.positionYAmount,
          fx: b.positionFeeXAmount, fy: b.positionFeeYAmount,
        });
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
    // Sanity: the planned top must be near the on-chain active bin. A large gap
    // means the plan is in the wrong domain (e.g. UI-vs-raw price decimals,
    // incident 2026-08-07) or wildly stale — refuse rather than strand capital.
    const gap = Math.abs(activeBin.binId - params.range.maxBinId);
    if (gap > 150) {
      throw new Error(
        `range sanity: planned top bin ${params.range.maxBinId} is ${gap} bins from on-chain active ${activeBin.binId} — refusing to open`
      );
    }
    // Re-anchor to the LIVE active bin (§3: top = current price). Planner
    // ranges are computed at scan time and vetting takes up to minutes; on a
    // fast riser the market moves 10%+ above the planned top, stranding the
    // ladder below (chrome pos#5 incident). Price rose: shift the whole range
    // up, preserving planned width/depth. Price fell: top clamps to active,
    // fib-anchored bottom stays (never place liquidity above the market).
    const width = params.range.maxBinId - params.range.minBinId;
    const maxBin = activeBin.binId;
    const minBin = activeBin.binId > params.range.maxBinId
      ? maxBin - width
      : Math.min(params.range.minBinId, maxBin - 1);
    const totalBins = maxBin - minBin + 1;
    const liveEntryPrice = Number(pool.fromPricePerLamport(Number(activeBin.price)));
    const lamports = Math.floor(params.sizeSol * 1e9);

    // Split into <=69-bin chunks, SOL per chunk proportional to linear bid-ask
    // weights (deeper bins carry more).
    const chunks: Array<{ min: number; max: number; share: number }> = [];
    const totalW = (totalBins * (totalBins + 1)) / 2;
    for (let start = 0; start < totalBins; start += BINS_PER_ACCOUNT) {
      const end = Math.min(start + BINS_PER_ACCOUNT - 1, totalBins - 1);
      let w = 0;
      for (let i = start; i <= end; i++) w += i + 1; // index 0 = top bin
      chunks.push({ min: maxBin - end, max: maxBin - start, share: w / totalW });
    }

    const accountRows: Array<{ pubkey: string; min: number; max: number }> = [];
    const sigs: string[] = [];
    for (const chunk of chunks) {
      const positionKp = Keypair.generate();
      const tx = await pool.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        user: this.wallet.publicKey,
        totalXAmount: new BN(0),
        totalYAmount: new BN(Math.floor(lamports * chunk.share)),
        strategy: { minBinId: chunk.min, maxBinId: chunk.max, strategyType: StrategyType.BidAsk },
        slippage: config().entry.liquidity_slippage_pct,
      });
      const sig = await this.send(tx, [positionKp]);
      sigs.push(sig);
      accountRows.push({ pubkey: positionKp.publicKey.toBase58(), min: chunk.min, max: chunk.max });
      console.log(`[live] opened position account ${positionKp.publicKey.toBase58()} bins [${chunk.min},${chunk.max}] tx ${sig}`);
    }

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
      const swap = await swapToSolEscalating(
        this.connection, this.wallet, position.tokenMint, feeXRaw, config().exec.exit_slippage_bps
      ).catch((e) => {
        console.error("[live] fee swap failed (residual sweep will retry):", (e as Error).message);
        return null;
      });
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
    db.prepare(
      "UPDATE positions SET fees_claimed_sol = fees_claimed_sol + ?, fees_measured_sol = fees_measured_sol + ? WHERE id = ?"
    ).run(feesSol, measured ?? 0, position.id);
    return { claimedSol: feesSol, txCostSol: 0.0005 * txs.length };
  }

  async withdraw(position: Position, bps: number): Promise<{ withdrawnSol: number; txCostSol: number }> {
    const pool = await this.pool(position.poolAddress);
    const { priceYperX, positions } = await this.ourLbPositions(position);
    const xDecimals = pool.tokenX.mint.decimals;
    const before = this.valueOf(positions, priceYperX, xDecimals);

    for (const p of positions) {
      const txs = await pool.removeLiquidity({
        user: this.wallet.publicKey,
        position: p.publicKey,
        fromBinId: p.positionData.lowerBinId,
        toBinId: p.positionData.upperBinId,
        bps: new BN(bps),
        shouldClaimAndClose: false,
      });
      for (const tx of txs) await this.send(tx);
    }
    const withdrawn = (before.valueSol - before.feesSol) * (bps / 10_000);
    const db = getDb();
    db.prepare("INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol, detail_json) VALUES (?, ?, 'profit_lock', ?, ?, ?)")
      .run(position.id, now(), withdrawn, 0.001, JSON.stringify({ bps }));
    db.prepare("UPDATE positions SET entry_sol = entry_sol * (1 - ? / 10000.0), profit_lock_fires = profit_lock_fires + 1 WHERE id = ?")
      .run(bps, position.id);
    return { withdrawnSol: withdrawn, txCostSol: 0.001 };
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
    for (const p of positions) {
      xToSwap += BigInt(Math.floor(Number(p.positionData.totalXAmount))) + BigInt(p.positionData.feeX.toString());
      const txs = await pool.removeLiquidity({
        user: this.wallet.publicKey,
        position: p.publicKey,
        fromBinId: p.positionData.lowerBinId,
        toBinId: p.positionData.upperBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true,
      });
      for (const tx of txs) sigs.push(await this.send(tx));
    }

    // Manual zap-out: swap all withdrawn token-side to SOL. On a below-range
    // exit this leg IS the exit value — the remove-liquidity tx returns only
    // rent — so its signature must reach the delta or the close reads as a
    // total loss.
    if (xToSwap > 0n) {
      const swap = await swapToSolEscalating(
        this.connection, this.wallet, position.tokenMint, xToSwap, slippageBps
      ).catch((e) => {
        console.error("[live] close swap failed — residual sweep will retry:", (e as Error).message);
        return null;
      });
      if (swap) sigs.push(swap.signature);
    }

    // Never write terminal state for a close that sent nothing. walletDelta([])
    // returns 0, not null, so an empty send would be recorded as a MEASURED
    // zero return — indistinguishable from a real total loss. claimFees already
    // guards this shape at its top; close() and withdraw() did not.
    if (sigs.length === 0 && this.accountKeys(position.id).length > 0) {
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
    const closeReturnSol = await this.walletDelta(sigs);

    const db = getDb();
    // `before.feesSol` is what shouldClaimAndClose collected on the way out.
    // It is already inside closeReturnSol; recorded separately so fee income is
    // attributable at all (see the fees_at_close_sol migration note in db.ts).
    db.prepare(
      "UPDATE positions SET state = ?, exit_ts = ?, exit_sol = ?, exit_reason = ?, close_return_sol = ?, fees_at_close_sol = ? WHERE id = ?"
    // NOT NULL column: better-sqlite3 binds NaN as NULL, and this UPDATE runs
    // AFTER removeLiquidity and the zap-out have irreversibly landed. A throw
    // here would leave state='open' on a position with nothing on chain, which
    // the next tick reads as valueSol 0 and writes off as a total loss.
    ).run(
      stateByReason[reason], now(), before.valueSol, reason, closeReturnSol,
      Number.isFinite(before.feesSol) ? before.feesSol : 0, position.id
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
        // Chain legs, so attribution reconciles without a wallet scan
        // (RANGE-SHAPE-DECISION.md item 3).
        legs: { feesSolMarked: before.feesSol, feeXRaw: before.feeXRaw.toString(), xToSwapRaw: xToSwap.toString() },
        // Per-bin composition at exit. Paired with the 'open' event's bins this
        // gives y_deposited(d) and (y(d), x(d)) per bin — both sides of
        // L(d) = y_deposited(d) - (y(d) + x(d) * p_exit).
        bins: closeBins,
      })
    );
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
    const closable: Array<{ pubkey: PublicKey; programId: PublicKey }> = [];
    const TOKEN_PROGRAMS = [
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    ];
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
          if (this.mintIsIdle(info.mint)) closable.push({ pubkey: acc.pubkey, programId });
          continue;
        }
        const raw = BigInt(info.tokenAmount.amount);
        const quoted = await quoteToSolLamports(info.mint, raw);
        if (quoted === null || quoted < minSol * 1e9) continue;
        const owner = db.prepare(
          "SELECT id, symbol FROM positions WHERE token_mint = ? ORDER BY id DESC LIMIT 1"
        ).get(info.mint) as { id: number; symbol: string } | undefined;
        const symbol = owner?.symbol ?? info.mint.slice(0, 8);
        try {
          const res = await swapToSolEscalating(
            this.connection, this.wallet, info.mint, raw, config().exec.exit_slippage_bps
          );
          if (!res) continue;
          // Credit it back to the position that stranded it. A sweep is a
          // failed claim/close zap-out arriving late, not found money: BUTTHOLE
          // pos#10's failed exit swap came back as 0.0254 SOL, 7% of that
          // position's entire return, and used to land in `ledger` attributed
          // to nothing. Measured, not quoted — the quote is what we asked for.
          const soldSol = (await this.walletDelta([res.signature])) ?? res.outLamports / 1e9;
          if (owner) {
            db.prepare("UPDATE positions SET recovered_sol = recovered_sol + ? WHERE id = ?")
              .run(soldSol, owner.id);
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
  private async closeEmptyAccounts(accounts: Array<{ pubkey: PublicKey; programId: PublicKey }>): Promise<void> {
    const BATCH = 12; // close ix are tiny, but leave room for the priority-fee ix
    for (let i = 0; i < accounts.length; i += BATCH) {
      const batch = accounts.slice(i, i + BATCH);
      const tx = new Transaction();
      for (const a of batch)
        tx.add(createCloseAccountInstruction(a.pubkey, this.wallet.publicKey, this.wallet.publicKey, [], a.programId));
      try {
        const sig = await this.send(tx);
        const delta = await this.walletDelta([sig]);
        getDb().prepare(
          "INSERT INTO events (position_id, ts, type, tx_sig, sol_delta, detail_json) VALUES (NULL, ?, 'rent_reclaim', ?, ?, ?)"
        ).run(now(), sig, delta ?? 0, JSON.stringify({ accounts: batch.map((a) => a.pubkey.toBase58()) }));
        console.log(`[live] 🧹 reclaimed rent from ${batch.length} empty token account(s) — +${(delta ?? 0).toFixed(5)} SOL (tx ${sig})`);
      } catch (e) {
        console.error("[live] rent reclaim failed:", (e as Error).message.split("\n")[0]);
      }
    }
  }
}
