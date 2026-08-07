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
import { swapToSol } from "./jupiter.js";
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
    this.wallet = loadKeypair(env().walletKeypairPath);
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
    const pool = await this.pool(params.poolAddress);
    const activeBin = await pool.getActiveBin();
    // One-sided below price: clamp top to the CURRENT on-chain active bin so a
    // stale datapi price can never place us above the market.
    const maxBin = Math.min(params.range.maxBinId, activeBin.binId);
    const minBin = Math.min(params.range.minBinId, maxBin - 1);
    const totalBins = maxBin - minBin + 1;
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

    const db = getDb();
    const res = db.prepare(
      `INSERT INTO positions (mode, pool, token_mint, symbol, tranche_of, entry_ts, entry_price, entry_sol,
        min_bin_id, max_bin_id, state, rent_paid_sol)
       VALUES ('live', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
    ).run(
      params.poolAddress, params.tokenMint, params.symbol, params.trancheOf ?? null,
      now(), params.entryPrice, params.sizeSol, minBin, maxBin, params.range.estBinRentSol
    );
    const id = Number(res.lastInsertRowid);
    for (const a of accountRows)
      db.prepare("INSERT INTO position_accounts (position_id, pubkey, min_bin_id, max_bin_id) VALUES (?, ?, ?, ?)")
        .run(id, a.pubkey, a.min, a.max);

    return {
      id, mode: "live", poolAddress: params.poolAddress, tokenMint: params.tokenMint,
      symbol: params.symbol, trancheOf: params.trancheOf ?? null, entryTs: now(),
      entryPrice: params.entryPrice, entrySol: params.sizeSol, minBinId: minBin,
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
      await swapToSol(this.connection, this.wallet, position.tokenMint, feeXRaw, config().exec.exit_slippage_bps)
        .catch((e) => console.error("[live] fee swap failed (tokens remain in wallet):", (e as Error).message));
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
      await swapToSol(this.connection, this.wallet, position.tokenMint, xToSwap, slippageBps)
        .catch((e) => console.error("[live] close swap failed — tokens remain in wallet, swap manually:", (e as Error).message));
    }

    const stateByReason: Record<ExitReason, string> = {
      P0_safety: "closed_safety", P1_stop: "closed_stop", P2_rotation: "closed_rotation",
      P3_above: "closed_win", P5_below: "closed_below", manual: "closed_manual",
    };
    const db = getDb();
    db.prepare("UPDATE positions SET state = ?, exit_ts = ?, exit_sol = ?, exit_reason = ? WHERE id = ?")
      .run(stateByReason[reason], now(), before.valueSol, reason, position.id);
    db.prepare("INSERT INTO events (position_id, ts, type, sol_delta, tx_cost_sol) VALUES (?, ?, ?, ?, ?)")
      .run(position.id, now(), reason === "P0_safety" ? "safety_exit" : "withdraw", before.valueSol, 0.001);
    return { exitSol: before.valueSol, txCostSol: 0.001 };
  }

  async walletSol(): Promise<number> {
    return (await this.connection.getBalance(this.wallet.publicKey)) / 1e9;
  }
}
