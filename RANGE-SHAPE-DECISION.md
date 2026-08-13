# Range shape: pre-registered decision rule

**Written 2026-08-10, before the data exists. Do not edit the thresholds after
looking at the results — that is the only thing that makes this document worth
anything.**

## The question

The bot places one-sided SOL liquidity below spot using `StrategyType.BidAsk`,
which weights the *deepest* bins heaviest. Measured across 24 closed positions,
the median position converted **7.2%** of its capital to inventory (mean 23% ±
2pp, capital-weighted 21.1%). Most deployed capital never trades.

The obvious inference — "move the capital to where the price actually goes" —
does not follow from the data:

```
corr(conversion, measured PnL) = +0.08 Pearson / +0.24 Spearman
corr(fee yield, traversal)     = +0.80
corr(inventory yield, traversal) = -0.79
corr(net yield, traversal)     = -0.14

fell_deep = 1   5 positions   1.5375 SOL deployed   net -0.0118
fell_deep = 0  18 positions   6.6369 SOL deployed   net +0.0744
```

Deep traversal buys fee income with inventory loss at slightly worse than par.
Apu (-0.0497) and LOUIE (-0.0207), the two worst losses in the book, are the two
highest-conversion positions. Net PnL against traversal is hump-shaped.

## Why it is undecidable today

A Spot-vs-BidAsk backtest was run and rejected, not because it lost but because
it cannot be trusted:

1. **The cost side is measured ~1.9x too small** — the inventory model totals
   -0.1017 SOL against a chain-reconciled -0.1928. Spot converts ~1.4x more
   capital at every depth, so the understated side is exactly the side the
   change increases.
2. **The fee side is fitted, not measured.** Per-position
   `alpha = chain fee / modelled crossing exposure` spans 0.012-0.286, and 0.286
   is ~3x the protocol's `MAX_FEE_RATE`. The crossing model demonstrably
   captures a minority of fee-generating volume; the rest is intra-bin
   oscillation the model cannot see.
3. **The counterfactual freezes the exits it would move.** P1 fires on
   `valueSol / entrySol < 0.75` and `valueSol` marks the token side at spot, so
   faster conversion means faster MTM decay and earlier stops. One replay gives
   Spot zero extra stops; another gives one, with Pill #23 — the book's best
   position at +0.0760, 121% of ex-claudius net — landing at 0.812 against a
   0.75 threshold.
4. **Expectancy is n≈2.** Ex-claudius net is +0.0626 over 23 closes. Remove Pill
   and BOT and the remaining 21 sum to **-0.0545**. There is no established edge
   to optimise, and the sample contains zero rugs in 3.5 days — the failure mode
   STRATEGY.md §9 explicitly accepts.

## What is being measured

Three read-only additions on existing code paths. No execution risk.

| # | What | Where |
|---|---|---|
| 1 | `position_marks` — one row per 15s poll: `active_bin_id`, `price`, `value_sol`, `value_frac`, `unclaimed_fees_sol`, `in_range` | `manager/loop.ts`, from the `mark()` we already pay for and discarded |
| 2 | Per-bin composition at **open**, **each claim**, and **close**: `binId, price, positionX/Y, positionFeeX/Y` | `executor/live.ts`, into `events.detail_json` |
| 3 | Open signatures and chain legs at close (`feesSolMarked`, `feeXRaw`, `xToSwapRaw`) | `executor/live.ts` |

Item 2 is the decisive one: ~50 bin-observations per position, so the
fee-vs-depth and loss-vs-depth curves become measurable at roughly 50x the
sample rate of per-position PnL. The open snapshot is not optional — it carries
`y_deposited(d)`, the denominator of the loss curve, and it is unrecoverable
once bins have traded.

## Stopping rule

Stop when **20 closed positions carry per-bin data, of which at least 5
traversed past 25% of range depth.**

At the observed close rate the position count needs ~3 days; the deep-traversal
condition will bind, so budget **5-7 days**. Do not stop early on the count
alone — the entire shape decision lives in the deep tail and today's sample has
five of them.

## The rule

Pooled across positions, normalised per SOL of liquidity in the bin, at depth
`d`:

```
F(d) = feeY(d) + feeX(d) * p_exit                            realized fee
L(d) = y_deposited(d) - (y(d) + x(d) * p_exit)               realized inventory loss

net(shape) = SUM_d  w_shape(d) * [ F(d) - L(d) ]             per SOL deployed
```

with `w_bidask(d)` the chunked on-chain ramp — note it **restarts at 1 at each
69-bin account's own top bin**, it is not globally linear — and `w_spot(d)`
uniform.

**Ship Spot only if BOTH hold:**

- `net(Spot) - net(BidAsk) > +1.5pp of deployed`, and
- replaying `value_frac` under Spot weights across the recorded
  `position_marks` series trips **zero** additional P1 stops, and leaves every
  position's minimum `value_frac` above **0.78**.

If the first fails, keep BidAsk. **If the second fails, the prerequisite is
reworking P1** — compute the stop on (SOL side + token side valued at
weighted-average acquisition price) rather than at spot — not shipping the shape
anyway.

## Data-integrity checks (run at 48h; if any fails the clock resets)

**(a) Marks are landing at 15s.**
```sql
SELECT position_id, COUNT(*) n, ROUND(AVG(gap),1) mean_gap, MAX(gap) max_gap
FROM (SELECT position_id, ts - LAG(ts) OVER (PARTITION BY position_id ORDER BY ts) gap
      FROM position_marks)
WHERE gap IS NOT NULL GROUP BY position_id;
```
Pass: `mean_gap` in 14-20s and `max_gap < 60` on every position. A `max_gap >= 60`
means the new table is no better than `pool_snapshots` and the poll is blocked.

**(b) Per-bin data on every close.**
```sql
SELECT COUNT(*) closes, SUM(json_extract(detail_json,'$.bins') IS NOT NULL) with_bins
FROM events WHERE type IN ('withdraw','safety_exit') AND ts > <deploy_ts>;
```
Pass: `with_bins = closes`, and per-bin `y` sums to within 0.5% of the tx's
`RemoveLiquidityByRange2` `amounts[1]`.

**(c) Attribution reconciles without a chain scan.** For each close after
deploy, `|pnl_db - pnl_legs| < 0.0005 SOL`. Today the two disagree by the full
fee amount on 20 of 24 rows.

**(d) The book has not deteriorated while waiting.**
```sql
SELECT COUNT(*) n, ROUND(SUM(entry_sol),4) deployed,
       ROUND(SUM(close_return_sol + fees_measured_sol + recovered_sol - open_cost_sol),6) net
FROM positions WHERE close_return_sol IS NOT NULL AND id <> 9 AND exit_ts > <deploy_ts>;
```
Stop the programme and re-examine entry selection if `net < -0.05 SOL` over the
window. Nothing in the instrumentation can cause that, but it would mean shape
is not the binding constraint.

## Do not, while waiting

- **Do not reverse or flatten the ramp because utilization is 23%.** Conversion
  predicts fees, and fees are not the objective. See the correlations above.
- **Do not treat idle deep capital as opportunity cost.** With
  `max_positions = 3`, `kelly_max_position_frac = 0.10` and `reserve_sol = 1.0`
  on ~6.75 SOL, the counterfactual use of unreached-bin capital is sitting in
  the wallet — which is what it does anyway. Position rent is fully refunded and
  nets to exactly 0 on every closed position.
- **Do not adopt `StrategyType.Curve`.** It marks 5-15pp below BidAsk at the
  same price and trips the 0.75 stop on three positions in replay, Pill at 0.756.
- **Do not lower `min_down_pct`** — and never without first fixing the escape
  hatch. `escape_hatch_depth_pct = 60` is a *fraction of range depth*
  (`loop.ts`: `frac = (maxBinId - activeBinId) / depth`). At 40% width it arms
  at -25.6% (5 of 24 positions); at 25% width, -16.4% (11 of 24); at 20%, 13 of
  24. Narrow the range without re-expressing this in absolute price terms and
  you get an exit-on-every-wiggle bot.
- **Do not expect `max_down_pct` to do much.** `planner.ts` applies
  `min_down_pct` **last**, as a hard floor: 18 of 24 entries planned -40.24% to
  -40.65%, the floor binding exactly. `min_down_pct` is the width lever.
- **Do not use `fees_measured_sol` for Kelly, gates, sizing or rotation** until
  the historical backfill lands. It under-reports chain fees by 1.9-2.5x.
  `kelly_min_samples = 50` is currently the only thing keeping it out of live
  sizing.
- **Do not weaken `stop_loss_frac` on the "exited at the low" story.** Apu #11
  exited 1.0% above its low and the price fell a further 75.2% within 2h; ZEUS
  #24 exited 9.4% above its low, then -31.5%. Two of three deep exits fired
  ahead of continued collapse.
- **Do not ship a shape change and a width change together.** Independent
  levers; stacking them makes attribution impossible.

## Known gap, not covered by this programme

The historical backfill of `fees_at_close_sol` / `fees_measured_sol` for
positions 2-22 from chain `ClaimFee2` is **not** part of this instrumentation —
it is forward-looking only. Until that backfill lands, any book-wide fee total
under-reports, and pre-2026-08-09 zero-fee readings are a recording artifact
rather than evidence.

## Status 2026-08-13 (observation only — thresholds above are unchanged)

Stopping rule sample is met: 32 closed positions carry per-bin/`position_marks`
data, 25 of them traversed ≥25% of range depth (need 20 and 5). Integrity (a)
mostly holds (`mean_gap` 16–19s) but **fails** on three positions with
`max_gap` 70–78s (#37 BOT, #38 Remus, #39 MARIO64). Integrity (d) holds:
post-instrumentation net excluding claudius #9 is **+0.077 SOL**, above the
−0.05 stop.

Do **not** ship Spot. The live P&L story since this note was written is that
escape-hatch closes are the edge (+0.62 SOL / 9) and P1 stops are the tax
(−0.55 SOL / 8). That is a stop-definition and inventory problem, not a
missing-Spot problem — same conclusion as the original rule's second clause.
