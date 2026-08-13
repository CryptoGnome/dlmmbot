import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createRequire } from "node:module";
import {
  Zap,
  estimateDlmmRebalanceSwap,
  DEFAULT_JUPITER_API_URL,
  type RebalanceDlmmPositionResponse,
} from "@meteora-ag/zap-sdk";
import type { LbPosition } from "@meteora-ag/dlmm";
import { config, env } from "../config.js";

const dlmmMod = createRequire(import.meta.url)("@meteora-ag/dlmm") as {
  default?: { StrategyType: { BidAsk: number; Spot: number } };
  StrategyType: { BidAsk: number; Spot: number };
};
const StrategyType = dlmmMod.default?.StrategyType ?? dlmmMod.StrategyType;

/** Thrown when a rebalance leg fails after earlier legs already landed. */
export class PartialRebalanceError extends Error {
  readonly sigs: string[];
  constructor(message: string, sigs: string[]) {
    super(message);
    this.name = "PartialRebalanceError";
    this.sigs = sigs;
  }
}

export function zapSdkConfig() {
  return {
    jupiterApiUrl: DEFAULT_JUPITER_API_URL,
    jupiterApiKey: env().jupiterApiKey ?? "",
  };
}

/** Anchor escape reshape: preserve width, top = active bin. */
export function escapeRebalanceDeltas(
  minBinId: number, maxBinId: number, activeBinId: number,
): { minDeltaId: number; maxDeltaId: number; newMinBinId: number; newMaxBinId: number } {
  const width = maxBinId - minBinId;
  const minDeltaId = -width;
  const maxDeltaId = 0;
  return {
    minDeltaId,
    maxDeltaId,
    newMinBinId: activeBinId + minDeltaId,
    newMaxBinId: activeBinId + maxDeltaId,
  };
}

export function liquiditySlippageBps(): number {
  return Math.round(config().entry.liquidity_slippage_pct * 100);
}

/** Send rebalance tx sequence from Zap SDK (setup → rebalance → swap → ledger → zap-in → cleanup).
 *  Throws if any leg fails AFTER an earlier leg already landed — callers must treat that as
 *  a half-applied reshape (liquidity may already be gone from the old bins). */
export async function sendRebalanceResponse(
  resp: RebalanceDlmmPositionResponse,
  send: (tx: Transaction) => Promise<string>,
): Promise<string[]> {
  const sigs: string[] = [];
  const legs: Array<[string, Transaction | null | undefined]> = [
    ["setup", resp.setupTransaction],
    ["initBinArray", resp.initBinArrayTransaction],
    ["rebalance", resp.rebalancePositionTransaction],
    ["swap", resp.swapTransaction],
    ["ledger", resp.ledgerTransaction],
    ["zapIn", resp.zapInTransaction],
    ["cleanup", resp.cleanUpTransaction],
  ];
  for (const [name, tx] of legs) {
    if (!tx || tx.instructions.length === 0) continue;
    try {
      sigs.push(await send(tx));
    } catch (e) {
      const tip = (e as Error).message?.split("\n")[0] ?? String(e);
      throw new PartialRebalanceError(
        `rebalance ${name} failed after ${sigs.length} prior sig(s)` +
        (sigs.length ? ` (liquidity may already be moved): ${tip}` : `: ${tip}`),
        sigs,
      );
    }
  }
  return sigs;
}

export interface EscapeRebalanceParams {
  connection: Connection;
  wallet: Keypair;
  poolAddress: string;
  minBinId: number;
  maxBinId: number;
  activeBinId: number;
  lbPositions: LbPosition[];
  swapSlippageBps: number;
  send: (tx: Transaction) => Promise<string>;
}

export async function runEscapeRebalance(p: EscapeRebalanceParams): Promise<{
  ok: boolean;
  sigs: string[];
  newMinBinId: number;
  newMaxBinId: number;
}> {
  if (!config().exec.use_zap) {
    return { ok: false, sigs: [], newMinBinId: p.minBinId, newMaxBinId: p.maxBinId };
  }
  const { minDeltaId, maxDeltaId, newMinBinId, newMaxBinId } =
    escapeRebalanceDeltas(p.minBinId, p.maxBinId, p.activeBinId);
  const lbPair = new PublicKey(p.poolAddress);
  const zap = new Zap(p.connection, zapSdkConfig());
  const liqSlip = liquiditySlippageBps();
  const sigs: string[] = [];

  for (const lbPos of p.lbPositions) {
    const estimate = await estimateDlmmRebalanceSwap({
      lbPair,
      position: lbPos.publicKey,
      connection: p.connection,
      minDeltaId,
      maxDeltaId,
      swapSlippageBps: p.swapSlippageBps,
      strategy: StrategyType.BidAsk,
      config: zapSdkConfig(),
    });
    const resp = await zap.rebalanceDlmmPosition({
      lbPair,
      position: lbPos.publicKey,
      user: p.wallet.publicKey,
      minDeltaId,
      maxDeltaId,
      liquiditySlippageBps: liqSlip,
      swapSlippageBps: p.swapSlippageBps,
      strategy: StrategyType.BidAsk,
      favorXInActiveId: false,
      directSwapEstimate: estimate.result,
    });
    sigs.push(...await sendRebalanceResponse(resp, p.send));
  }

  return { ok: sigs.length > 0, sigs, newMinBinId, newMaxBinId };
}
