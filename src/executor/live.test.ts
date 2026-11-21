import { describe, it, expect } from "vitest";
import {
  txErrorDetail,
  landedTxError,
  rangeGapTooLarge,
  resolveOpenBins,
  shouldRebuildOpenOnSlippage,
  wealthDeltaLamports,
  OPEN_SLIPPAGE_REBUILDS,
} from "./live.js";
import { classifyLeftover, RESIDUAL_SWEEP_MIN_SOL } from "./executor.js";
import { UNDERFILL_INCIDENT_SHARE } from "./live.js";
import { PublicKey } from "@solana/web3.js";
import { SOL_MINT } from "../config.js";

describe("txErrorDetail", () => {
  it("extracts ExceededBinSlippageTolerance from 0x1774", () => {
    const d = txErrorDetail({
      message: "Simulation failed.\nCustom program error: 0x1774",
      logs: ["Program log: AnchorError caused by account: bin_array. Error Code: ExceededBinSlippageTolerance. Error Number: 6004."],
    });
    expect(d.code).toBe("ExceededBinSlippageTolerance");
    expect(d.summary).toContain("ExceededBinSlippageTolerance");
    expect(d.summary).not.toMatch(/^ExceededBinSlippageTolerance — Simulation failed\.?$/);
  });

  it("does not let truncated Simulation failed. win as the tip alone without code", () => {
    const d = txErrorDetail({
      message: "Simulation failed.\nCustom program error: 0x1774",
      logs: [],
    });
    expect(d.code).toBe("ExceededBinSlippageTolerance");
    expect(d.summary.toLowerCase()).not.toBe("simulation failed.");
  });

  it("reads named Error Code from logs", () => {
    const d = txErrorDetail({
      message: "Transaction failed",
      logs: ["Error Code: InsufficientFunds"],
    });
    expect(d.code).toBe("InsufficientFunds");
  });
});

describe("landedTxError", () => {
  it("names the program code from a confirmed-but-failed tx so open can rebuild", () => {
    const e = landedTxError("SIG", {
      err: { InstructionError: [2, { Custom: 6004 }] },
      logMessages: [
        "Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]",
        "Program log: AnchorError thrown in programs/lb_clmm/src/instructions/deposit/add_liquidity_by_strategy.rs:41. Error Code: ExceededBinSlippageTolerance. Error Number: 6004. Error Message: Exceeded bin slippage tolerance.",
      ],
    });
    expect(e.code).toBe("ExceededBinSlippageTolerance");
    expect(e.message).toMatch(/SIG — ExceededBinSlippageTolerance/);
    expect(txErrorDetail(e).code).toBe("ExceededBinSlippageTolerance");
    expect(shouldRebuildOpenOnSlippage(txErrorDetail(e).code, 0)).toBe(true);
  });

  it("still reports the signature when the tx cannot be fetched", () => {
    const e = landedTxError("SIG", null);
    expect(e.code).toBeNull();
    expect(e.message).toBe("tx landed with on-chain error: SIG — tx not retrievable");
  });
});

describe("live open/mark guards", () => {
  it("refuses range gap > 150 bins", () => {
    expect(rangeGapTooLarge(1000, 1200)).toBe(true);
    expect(rangeGapTooLarge(1000, 1100)).toBe(false);
  });

  it("rebuilds on slippage for early attempts only", () => {
    expect(shouldRebuildOpenOnSlippage("ExceededBinSlippageTolerance", 0)).toBe(true);
    expect(shouldRebuildOpenOnSlippage("ExceededBinSlippageTolerance", OPEN_SLIPPAGE_REBUILDS)).toBe(false);
    expect(shouldRebuildOpenOnSlippage("InsufficientFunds", 0)).toBe(false);
  });
});

describe("wealthDeltaLamports", () => {
  const wallet = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
  const other = new PublicKey("11111111111111111111111111111111");

  it("counts native + wSOL as one wealth figure", () => {
    const keys = [{ pubkey: other }, { pubkey: wallet }];
    const meta = {
      preBalances: [0, 1_000_000_000],
      postBalances: [0, 999_992_970], // -0.00000703 native
      preTokenBalances: [
        { accountIndex: 2, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "0", decimals: 9, uiAmount: 0 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "603934037", decimals: 9, uiAmount: 0.603934037 } },
      ],
    };
    const d = wealthDeltaLamports(meta as never, keys, wallet);
    expect(d).toBe(603934037 - 7030);
  });

  it("nets unwrap (native up, wSOL down) to ~0", () => {
    const keys = [{ pubkey: wallet }];
    const meta = {
      preBalances: [1_000_000_000],
      postBalances: [1_600_000_000],
      preTokenBalances: [
        { accountIndex: 1, mint: SOL_MINT, owner: wallet.toBase58(), uiTokenAmount: { amount: "600000000", decimals: 9, uiAmount: 0.6 } },
      ],
      postTokenBalances: [],
    };
    const d = wealthDeltaLamports(meta as never, keys, wallet);
    expect(d).toBe(0);
  });
});

describe("classifyLeftover — what a close left in the wallet", () => {
  const MARK = 0.22;

  it("reports nothing when the close swept the token side clean", () => {
    expect(classifyLeftover(null, MARK, false)).toEqual({ kind: "none", share: null, creditSol: 0 });
  });

  // pos#15 BUTTHOLE, 2026-08-17: a WINNING close (+0.0002 SOL) that filed an
  // error over 0.00045 SOL of dust and claimed "residual sweep will sell it" —
  // for an amount sweepResiduals is guaranteed to skip.
  it("treats a leftover under the sweep floor as dust, not an incident", () => {
    const r = classifyLeftover(0.00045059, MARK, true);
    expect(r.kind).toBe("dust");
    expect(r.creditSol).toBe(0); // nothing will convert it — book the loss now
  });

  it("treats a leftover at or above the sweep floor as a recoverable strand", () => {
    const r = classifyLeftover(RESIDUAL_SWEEP_MIN_SOL, MARK, true);
    expect(r.kind).toBe("strand");
    expect(r.creditSol).toBe(RESIDUAL_SWEEP_MIN_SOL);
  });

  // ANSEM pos#8: 0.5327 SOL, 75% of mark — the case the detector exists for.
  it("flags a large under-fill and carries its full value as credit", () => {
    const r = classifyLeftover(0.532672767, 0.7144471699792198, true);
    expect(r.kind).toBe("strand");
    expect(r.creditSol).toBeCloseTo(0.532672767, 9);
    expect(r.share!).toBeGreaterThan(0.25); // clears the alert bar
  });

  // The three reports that motivated the split (2026-08-17/18), all "strand"
  // by the sweep floor, all winners, all sold by the sweep within minutes:
  //   BUTTHOLE pos#15  0.00045 / 0.22   (dust, handled above)
  //   Z500     pos#102 0.0022  / 0.254  = 0.9%
  //   67coin   pos#112 0.0098  / 0.633  = 1.5%
  // A strand is real (the sweep must sell it) but it is only an INCIDENT — a
  // paged report — when it is a material share of the mark. The alert has
  // drawn that line at 25% since v0.8.0; the log level now follows it.
  it("a sliver strand is under the incident line; ANSEM's 75% is over it", () => {
    const z500 = classifyLeftover(0.002220877, 0.25391442071265596, true);
    const coin = classifyLeftover(0.009793362, 0.6332123136224322, true);
    const ansem = classifyLeftover(0.532672767, 0.7144471699792198, true);
    expect(z500.kind).toBe("strand");
    expect(coin.kind).toBe("strand");
    expect(z500.share!).toBeLessThan(UNDERFILL_INCIDENT_SHARE);
    expect(coin.share!).toBeLessThan(UNDERFILL_INCIDENT_SHARE);
    expect(ansem.share!).toBeGreaterThanOrEqual(UNDERFILL_INCIDENT_SHARE);
  });

  it("flags an unquotable leftover rather than assuming it is dust", () => {
    // Being unable to price it is exactly when we must not write it off.
    const r = classifyLeftover(null, MARK, true);
    expect(r.kind).toBe("strand");
    expect(r.share).toBeNull();
    expect(r.creditSol).toBe(0); // but PnL may only count what we can value
  });

  it("returns no share when the mark is zero (empty close)", () => {
    expect(classifyLeftover(0.05, 0, true).share).toBeNull();
  });
});

/**
 * Live bin placement (2026-09-27). Failure modes written before the change:
 *  F1 a tranche planned fully below active is lifted to the active bin
 *  F2 price already inside/below the planned pocket still opens
 *  F3 the 150-bin gap sanity no longer applies to planned pockets
 *  F4 the primary ("active") rule changes: top, width, collapse refusal
 *  F5 a rebuild moves a planned pocket (the rebuild path re-validates through
 *     resolveOpenBins with the SAME bins, so F2's check is what it relies on)
 *  F6 callers that pass no anchor stop getting the primary rule
 * REGULARS pos#605/606 bins are the fixture: primary [-618,-567], tranche
 * planned [-636,-619], opened live at [-582,-565] with active -566.
 */
describe("resolveOpenBins", () => {
  const tranche = { minBinId: -636, maxBinId: -619 };
  const primary = { minBinId: -618, maxBinId: -567 };

  it("F1: keeps a planned pocket below active exactly where it was planned", () => {
    expect(resolveOpenBins(tranche, -566, "planned")).toEqual({ minBin: -636, maxBin: -619 });
  });

  it("F1 regression: the active rule is what lifted the REGULARS tranche to [-582,-565]", () => {
    expect(resolveOpenBins(tranche, -565, "active")).toEqual({ minBin: -582, maxBin: -565 });
  });

  it("F2: refuses when price has fallen into or below the pocket", () => {
    expect(() => resolveOpenBins(tranche, -619, "planned")).toThrow(/not below active/);
    expect(() => resolveOpenBins(tranche, -625, "planned")).toThrow(/not below active/);
    expect(() => resolveOpenBins(tranche, -700, "planned")).toThrow(/not below active/);
  });

  it("F3: the gap sanity still applies to planned pockets", () => {
    expect(() => resolveOpenBins(tranche, -619 + 151, "planned")).toThrow(/bins from on-chain active/);
    expect(resolveOpenBins(tranche, -619 + 150, "planned")).toEqual({ minBin: -636, maxBin: -619 });
  });

  it("F4: primary re-anchors its top to active and keeps its width", () => {
    expect(resolveOpenBins(primary, -560, "active")).toEqual({ minBin: -611, maxBin: -560 });
    expect(resolveOpenBins(primary, -567, "active")).toEqual({ minBin: -618, maxBin: -567 });
  });

  it("F4: primary clamps to its planned floor when price fell, and refuses a collapsed ladder", () => {
    expect(resolveOpenBins(primary, -580, "active")).toEqual({ minBin: -618, maxBin: -580 });
    expect(() => resolveOpenBins(primary, -600, "active")).toThrow(/re-anchored range is/);
  });

  it("F6: no anchor means the primary rule", () => {
    expect(resolveOpenBins(primary, -560)).toEqual(resolveOpenBins(primary, -560, "active"));
  });
});

import { landedOpenShape, openCostFromTxDeltas, splitRentReclaim } from "./executor.js";

// Written before the fix (2026-11-21 audit). Ways a two-account open can go wrong:
//   O1  account 1 lands, account 2 fails, and the landed SOL is left with no row
//   O2  the recorded size is the PLANNED size, so stops and exposure read against capital that never left the wallet
//   O3  the recorded bin range still spans the account that never opened
//   O4  nothing landed, and a row is written anyway
describe("landedOpenShape — a later position account failing must not orphan the first", () => {
  const top = { min: -350, max: -300, share: 0.35 };
  const bottom = { min: -400, max: -351, share: 0.65 };

  it("O1/O2/O3: records only what landed, at its own share and bins", () => {
    expect(landedOpenShape([top], 1.0)).toEqual({ sizeSol: 0.35, minBin: -350, maxBin: -300 });
  });
  it("a full open is the planned size over the full range", () => {
    const s = landedOpenShape([top, bottom], 0.8)!;
    expect(s.sizeSol).toBeCloseTo(0.8, 10);
    expect([s.minBin, s.maxBin]).toEqual([-400, -300]);
  });
  it("O4: nothing landed is not a position", () => {
    expect(landedOpenShape([], 1.0)).toBeNull();
  });
  it("never reports more than was planned if shares overshoot by rounding", () => {
    expect(landedOpenShape([{ ...top, share: 0.6 }, { ...bottom, share: 0.6 }], 1)!.sizeSol).toBe(1);
  });
});

//   R1  the shares do not sum to the tx delta, so the book drifts from the wallet
//   R2  an unfetchable tx records zero for rent that did come back
//   R3  a Token-2022 account (more rent) is credited the same as a plain one
describe("splitRentReclaim", () => {
  it("R1/R3: shares follow lamports and sum to the measured delta", () => {
    const shares = splitRentReclaim([2_039_280, 2_074_080], 0.004108);
    expect(shares[0]! + shares[1]!).toBeCloseTo(0.004108, 12);
    expect(shares[1]!).toBeGreaterThan(shares[0]!);
  });
  it("R2: an unknown delta falls back to the lamports that were in the accounts", () => {
    expect(splitRentReclaim([2_039_280], null)).toEqual([0.00203928]);
  });
  it("handles no accounts and zero-lamport accounts without dividing by zero", () => {
    expect(splitRentReclaim([], 0.002)).toEqual([]);
    expect(splitRentReclaim([0, 0], 0.002)).toEqual([0.001, 0.001]);
  });
});

//   C1  one of two open txs is unreadable and the half that was read becomes the basis
//   C2  a tx that paid the wallet (not an open) is taken as a negative cost
describe("openCostFromTxDeltas — cost basis of an adopted position", () => {
  it("sums every account's open tx", () => {
    expect(openCostFromTxDeltas([-0.4, -0.352502])).toBeCloseTo(0.752502, 9);
  });
  it("C1: any unknown delta means unknown, never a partial basis", () => {
    expect(openCostFromTxDeltas([-0.4, null])).toBeNull();
    expect(openCostFromTxDeltas([])).toBeNull();
  });
  it("C2: a net inflow is not an open cost", () => {
    expect(openCostFromTxDeltas([0.2])).toBeNull();
  });
});

import { sumKnownFeesSol } from "./executor.js";

// Written before the fix. events.tx_cost_sol was a constant per event type
// (0.0005 per open/claim tx, 0.001 per close) — 1.57 SOL reported against 0.10
// SOL actually paid. Ways the measured replacement can be wrong:
//   F1  one tx's fee is unknown and the rest are reported as the whole cost
//   F2  an event with no txs reports a cost
describe("sumKnownFeesSol", () => {
  const fees = new Map([["a", 5_000], ["b", 25_000]]);
  it("sums the fee of every tx in lamports → SOL", () => {
    expect(sumKnownFeesSol(["a", "b"], fees)).toBeCloseTo(0.00003, 12);
  });
  it("F1: any unknown fee means unknown, so the caller keeps its estimate", () => {
    expect(sumKnownFeesSol(["a", "zzz"], fees)).toBeNull();
  });
  it("F2: no txs cost nothing", () => {
    expect(sumKnownFeesSol([], fees)).toBe(0);
  });
});

import { ataMintIndex } from "./live.js";

// Written before the fix. Old rent-reclaim events name only token ACCOUNTS; the
// index maps an account back to its mint. Ways it can be wrong:
//   I1  a Token-2022 mint's account is missed (it derives a different address)
//   I2  one malformed mint in the positions table throws and nothing is attributed
describe("ataMintIndex", () => {
  const owner = new PublicKey("9DTThTbggnp2P2ZGLFRfN1A3j5JUsXez1dRJak3TixB2");
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  it("I1: indexes both the classic and the Token-2022 account of every mint", () => {
    const idx = ataMintIndex(owner, [usdc, SOL_MINT]);
    expect(idx.size).toBe(4);
    expect([...idx.values()].filter((m) => m === usdc)).toHaveLength(2);
    expect(new Set(idx.keys()).size).toBe(4);
  });
  it("I2: skips a malformed mint instead of throwing", () => {
    const idx = ataMintIndex(owner, ["not-a-mint", usdc]);
    expect(idx.size).toBe(2);
  });
});

import { chunkBins, strayChainAccounts } from "./executor.js";

// Found in review, written before the fix. A two-account open sends the top
// account first. If that tx hits bin slippage, open() re-anchors the range to
// the new active bin — but the second account still used bins computed from the
// ORIGINAL top, so the two accounts overlapped or left a gap by the shift and
// the recorded min_bin_id was off by it.
//   K1  the second account is not contiguous with the first after a re-anchor
//   K2  the accounts together do not span exactly [curMin, curMax]
describe("chunkBins — position accounts tile the CURRENT range", () => {
  it("K1/K2: after the range re-anchors 7 bins lower, account 2 follows account 1", () => {
    const curMax = -307, curMin = -407; // 101 bins, shifted down from [-400,-300]
    const top = chunkBins(0, curMin, curMax);
    const bottom = chunkBins(1, curMin, curMax);
    expect(top).toEqual({ min: -375, max: -307 });
    expect(bottom).toEqual({ min: -407, max: -376 });
    expect(bottom.max).toBe(top.min - 1);
  });
  it("a range that fits one account is a single chunk", () => {
    expect(chunkBins(0, -350, -300)).toEqual({ min: -350, max: -300 });
  });
});

//   S1  an account the bot opened but never recorded (tx fate unknown, landed
//       later) sits in a pool that already has an open row, so boot reconcile
//       skipped the whole pool and it stayed unmanaged
//   S2  an account belonging to a CLOSED row (its close never completed) is
//       grafted onto a different open position
//   S3  an empty shell is treated as a stray position
describe("strayChainAccounts", () => {
  const acct = (pubkey: string, hasLiquidity = true) => ({ pubkey, hasLiquidity });
  it("S1: an untracked funded account in a pool with an open row is a stray", () => {
    const r = strayChainAccounts([acct("a"), acct("x")], new Set(["a"]), new Set(["a"]));
    expect(r).toEqual({ attach: ["x"], foreign: [] });
  });
  it("S2: an account some closed row still owns is reported, never attached", () => {
    const r = strayChainAccounts([acct("a"), acct("old")], new Set(["a"]), new Set(["a", "old"]));
    expect(r).toEqual({ attach: [], foreign: ["old"] });
  });
  it("S3: empty shells and tracked accounts are ignored", () => {
    const r = strayChainAccounts([acct("a"), acct("shell", false)], new Set(["a"]), new Set(["a"]));
    expect(r).toEqual({ attach: [], foreign: [] });
  });
});
