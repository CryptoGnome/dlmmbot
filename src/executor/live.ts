import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
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
    this.connection = new Connection(env().rpcUrl, "confirmed");
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
   * Balance re-read that tolerates RPC lag after a confirmed tx: retries until
   * the value moves off `previous`. null = never moved (chrome pos#5: a read
   * raced the RPC and logged a false 0 delta) — callers record unknown, not 0.
   */
  private async balanceAfter(previous: number): Promise<number | null> {
    for (let i = 0; i < 6; i++) {
      const bal = await this.connection.getBalance(this.wallet.publicKey);
      if (bal !== previous) return bal;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
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

  private async ourLbPositions(position: Position): Promise<{ active: number; priceYperX: number; positions: LbPosition[] }> {
    const pool = await this.pool(position.poolAddress);
    await pool.refetchStates();
    const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(this.wallet.publicKey);
    const ours = new Set(this.accountKeys(position.id).map((k) => k.toBase58()));
    const priceYperX = Number(pool.fromPricePerLamport(Number(activeBin.price)));
    return {
      active: activeBin.binId,
      priceYperX,
      positions: userPositions.filter((p) => ours.has(p.publicKey.toBase58())),
    };
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
    const balBefore = await this.connection.getBalance(this.wallet.publicKey);
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
      accountRows.push({ pubkey: positionKp.publicKey.toBase58(), min: chunk.min, max: chunk.max });
      console.log(`[live] opened position account ${positionKp.publicKey.toBase58()} bins [${chunk.min},${chunk.max}] tx ${sig}`);
    }

    // Actual wallet debit for this open (size + all rents + tx fees) — the
    // truth for per-position PnL, unlike the estBinRentSol estimate.
    const balAfter = await this.balanceAfter(balBefore);
    const openCostSol = balAfter === null ? null : (balBefore - balAfter) / 1e9;

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

    const txs = await pool.claimAllSwapFee({ owner: this.wallet.publicKey, positions });
    for (const tx of txs) await this.send(tx);

    // Bank policy: token-side fees -> SOL immediately (§4 P4).
    if (feeXRaw > 0n) {
      await swapToSolEscalating(this.connection, this.wallet, position.tokenMint, feeXRaw, config().exec.exit_slippage_bps)
        .catch((e) => console.error("[live] fee swap failed (residual sweep will retry):", (e as Error).message));
    }

    const db = getDb();
    db.prepare("INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol) VALUES (?, ?, 'claim', ?, ?)")
      .run(position.id, now(), feesSol, 0.0005 * txs.length);
    db.prepare("UPDATE positions SET fees_claimed_sol = fees_claimed_sol + ? WHERE id = ?").run(feesSol, position.id);
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
    const balBefore = await this.connection.getBalance(this.wallet.publicKey);
    const pool = await this.pool(position.poolAddress);
    const { priceYperX, positions } = await this.ourLbPositions(position);
    const xDecimals = pool.tokenX.mint.decimals;
    const before = this.valueOf(positions, priceYperX, xDecimals);

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
      for (const tx of txs) await this.send(tx);
    }

    // Manual zap-out: swap all withdrawn token-side to SOL.
    if (xToSwap > 0n) {
      await swapToSolEscalating(this.connection, this.wallet, position.tokenMint, xToSwap, slippageBps)
        .catch((e) => console.error("[live] close swap failed — residual sweep will retry:", (e as Error).message));
    }

    const stateByReason: Record<ExitReason, string> = {
      P0_safety: "closed_safety", P1_stop: "closed_stop", P2_rotation: "closed_rotation",
      P3_above: "closed_win", P5_below: "closed_below", escape: "closed_escape", manual: "closed_manual",
    };
    // Actual wallet credit for this close (exit value + rent refunds - tx fees).
    const balAfter = await this.balanceAfter(balBefore);
    const closeReturnSol = balAfter === null ? null : (balAfter - balBefore) / 1e9;

    const db = getDb();
    db.prepare("UPDATE positions SET state = ?, exit_ts = ?, exit_sol = ?, exit_reason = ?, close_return_sol = ? WHERE id = ?")
      .run(stateByReason[reason], now(), before.valueSol, reason, closeReturnSol, position.id);
    db.prepare("INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol) VALUES (?, ?, ?, ?, ?)")
      .run(position.id, now(), reason === "P0_safety" ? "safety_exit" : "withdraw", before.valueSol, 0.001);
    return { exitSol: before.valueSol, txCostSol: 0.001 };
  }

  async walletSol(): Promise<number> {
    return (await this.connection.getBalance(this.wallet.publicKey)) / 1e9;
  }

  /**
   * Sell any wallet balance of a mint the bot has ever traded. Close/claim
   * zap-outs are best-effort — a failed swap strands tokens in the wallet with
   * nothing else ever looking at them again. Runs from the manager loop (same
   * single-threaded tick as closes, so it cannot race an in-flight exit).
   * Unknown mints (airdrop spam) are never touched; dust below `minSol` is
   * left alone so tx fees don't eat the proceeds.
   */
  async sweepResiduals(minSol: number): Promise<Array<{ mint: string; symbol: string; soldSol: number }>> {
    const db = getDb();
    const known = new Set(
      (db.prepare("SELECT DISTINCT token_mint FROM positions").all() as Array<{ token_mint: string }>)
        .map((r) => r.token_mint)
    );
    const recovered: Array<{ mint: string; symbol: string; soldSol: number }> = [];
    const TOKEN_PROGRAMS = [
      new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    ];
    for (const programId of TOKEN_PROGRAMS) {
      const accs = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId });
      for (const acc of accs.value) {
        const info = acc.account.data.parsed.info as { mint: string; tokenAmount: { amount: string } };
        if (!known.has(info.mint) || info.tokenAmount.amount === "0") continue;
        const raw = BigInt(info.tokenAmount.amount);
        const quoted = await quoteToSolLamports(info.mint, raw);
        if (quoted === null || quoted < minSol * 1e9) continue;
        const symbol = (db.prepare("SELECT symbol FROM positions WHERE token_mint = ? ORDER BY id DESC LIMIT 1")
          .get(info.mint) as { symbol: string } | undefined)?.symbol ?? info.mint.slice(0, 8);
        try {
          const res = await swapToSolEscalating(
            this.connection, this.wallet, info.mint, raw, config().exec.exit_slippage_bps
          );
          if (res) recovered.push({ mint: info.mint, symbol, soldSol: res.outLamports / 1e9 });
        } catch (e) {
          console.error(`[live] residual sweep ${symbol} failed:`, (e as Error).message.split("\n")[0]);
        }
      }
    }
    return recovered;
  }
}
