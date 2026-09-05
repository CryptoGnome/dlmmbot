# Range width: pre-registered decision rule

**Written 2026-08-25, before the data exists. Do not edit the thresholds after
looking at the results — that is the only thing that makes this document worth
anything.**

Sibling of `RANGE-SHAPE-DECISION.md`, which settled *shape* (BidAsk, not Spot)
and explicitly deferred *width*. That document's closing instruction stands:
**do not ship a shape change and a width change together.** Shape is settled;
this is the width lever and nothing else moves with it.

## The question

Is the meme range too WIDE? Not too narrow — the opposite of the question that
prompted it.

The prompt was a public argument for **−75% one-sided SOL BidAsk** ("room to be
wrong"; x.com/byJamesMarston, 2026-08-22). Measured against 176 closed live
positions on the server book, that direction is dead on arrival:

```
price reached -30% or deeper   44/176   25.0%
price reached -40% or deeper   26/176   14.8%
price reached -50% or deeper   13/176    7.4%
price reached -60% or deeper    1/176    0.6%
price reached -75% or deeper    0/176    0.0%

deepest drawdown  p50 -13.0%  p75 -30.8%  p90 -45.5%  p95 -52.1%  worst -61.9%
```

Nothing has ever traded at −75%, and one position in 176 has traded below the P0
line at −60%. Of the 13 that went past −50%, **12 were closed by P0 or P1** — we
had already exited, so bins below that are unreachable by construction, not
merely unprofitable.

The same measurement raises the inverse question. Median **range utilisation** —
the share of planned depth price actually traverses — is **28.3%**; only 33 of
176 positions (18.8%) use 95% or more. BidAsk weights the deepest bins heaviest,
so the median position puts most of its SOL where price never goes. Pooled by
planned depth:

| planned depth | n | fee yield | net return | win |
|---|---|---|---|---|
| −0..−25% | 15 | 2.62% | +2.57% | 60% |
| −25..−35% | 18 | 4.04% | +1.73% | 78% |
| −35..−45% | 68 | 4.46% | +1.62% | 63% |
| −45..−55% | 48 | 5.45% | +0.26% | 56% |
| −55..−80% | 27 | 1.09% | −0.15% | 30% |

**Hypothesis to test: a narrower range (`min_down_pct` 40 → 30) concentrates
capital nearer the active bin and earns more per SOL of cost.**

## Why the retrospective evidence cannot answer it

Three confounds, each fatal on its own. This is why the table above is a
question and not a finding.

1. **Depth is not assigned, it is derived from volatility.** `planner.ts` takes
   the shallower of the `fib_bottom` level of recent price action and
   `−max_down_pct`. A position gets a deeper range precisely when recent action
   was wilder. "Deeper did worse" and "more volatile did worse" are the same
   column of numbers.
2. **The narrow band is selected by the rent gate, not by a width policy.**
   `min_down_pct = 40` is a hard floor applied last
   ([planner.ts:140](src/ranges/planner.ts:140)), so nothing should plan
   shallower than −40% at all — and the median planned depth is −42.1%, the floor
   binding exactly. The 33 positions in the −0..−35% bands exist because
   `fitPlanToRentBudget` **shrank** them to fit `bin_rent_budget_sol`. They are
   therefore positions in pools with expensive or uninitialised bin arrays. That
   is a pool-quality selection, not a width treatment.
3. **The deep band is not a tranche artifact, but it is still selected.** 0 of
   the 27 positions at ≤−55% are tranche legs (checked), so
   `tranche_max_down_pct` is not the explanation — but they remain the tail of
   confound 1.

Randomised assignment removes all three at once. Nothing short of it will.

## Blocking prerequisite: re-express the escape hatch in absolute terms

**Do not run this experiment until this lands.** `escape_hatch_depth_pct = 60`
is a *fraction of range depth*, not a price:

```ts
const depth = pos.maxBinId - pos.minBinId;
const frac = depth > 0 ? (pos.maxBinId - mark.activeBinId) / depth : 0;
if (frac >= pm.escape_hatch_depth_pct / 100) { /* armed */ }   // loop.ts:1181
```

Bins are geometric, so the arming *price* moves with the width being tested:

| range width | escape hatch arms at | share of book that reaches it |
|---|---|---|
| −40% (today) | **−26.4%** | ~25% |
| −35% | −22.8% | ~33% |
| −30% (proposed) | **−19.3%** | ~40% |

Narrowing to −30% would arm the escape hatch on roughly 40% of positions instead
of 25% — and `escape` is currently a **winning** exit (26 closes, median deepest
−33.5%). The experiment would be measuring "we armed the escape hatch more
often", not "the range is narrower", and the two are not separable after the
fact. `RANGE-SHAPE-DECISION.md` flagged this on 2026-08-10 against the book as it
stood then (it quotes −25.6% for a −40.24% median width; the table above is
computed at a round −40%), and STRATEGY.md has listed "narrower meme ranges
without escape-hatch rework" under **Do not ship** ever since. This document is
the rule for lifting that, not for working around it.

**Prerequisite:** express escape-hatch arming as an absolute drawdown from entry
price, calibrated so that at today's −40% width it arms at the same −26.4% it
does now, then hold it fixed across both arms. `escape_hatch_recovery_pct = 25`
carries the same units and is owed the same audit before starting.

> **Addendum, 2026-08-25 — the prerequisite is built, and it is NOT a no-op.**
> The paragraph above assumed the conversion could be shipped invisibly. It
> cannot, and the reason is worth recording because it also constrains the
> experiment.
>
> The depth rule's thresholds scale with each position's *own* range, and the
> book's real depths are bimodal — **11–20%** (low-bin-step pools) and **40–50%**
> — not clustered at 40% as the planned-depth figure suggested. So one absolute
> pair cannot reproduce a rule that was never one rule. Replaying all 177 closed
> positions with marks, a sweep of (arm, recover) over 20–36% × 7–22% bottoms
> out at **26 changed**; the calibrated pair (26.4, 12.0) gives 27.
>
> Restricted to the 96 positions where the depth rule actually reproduces the
> real exit (the sim's fidelity discipline — it excludes majors, whose hatch is
> disabled in production, and follow legs), it changes **14**:
> - **4 measurable**, net +0.094 SOL — but carried entirely by one row (Normie
>   +0.127). Without it: **−0.033 SOL, worse on 3 of 4, median −0.005.**
> - **10 unmeasurable**: real escapes whose marks *end* at the escape, so
>   "held" re-reads the same mark and the counterfactual is unknowable.
>   `post_exit_prices` covers 3 and they disagree (+14%, −22%, +34%).
>
> By the standard this repo already applied when it rejected the dip-relative
> hatch ("it is four rows", "worse on 18 of 28"), that is not shippable. So it
> ships **instrumented-off** as `escape_hatch_absolute = false`, logging an
> `escape_absolute_deferred` decision whenever the two formulations disagree.
>
> **What this changes for the width test:** the stopping rule below cannot start
> until the absolute form is ON, and turning it on is now its own decision with
> its own evidence bar, gated on the live disagreement log rather than on a
> replay. Integrity check (c) is unchanged and becomes its regression test.
>
> **2026-09-05: prerequisite flipped ON** (`manage.escape_hatch_absolute = true`
> on both runtime configs, 26.4 / 12.0 thresholds) by operator request after a
> full strategy review found the depth gradient had held with more data: deep
> ranges (bottom below −45%, two accounts) n=71 **−0.60 SOL** at 49% win vs
> mid ranges (−45..−35%, one account) n=110 **+1.20** at 56% — on young (<6h)
> tokens −0.18 vs +1.40, the difference sitting entirely in P0/P1 stops (−2.05
> over 27 vs −0.64 over 21). The arm-assignment code below is **not built yet**;
> the stopping rule starts when it ships, server only.

## The design

**Randomised at entry, on a pure function of the mint.**

```
arm(mint) = sha256(mint)[0] & 1     0 = control (min_down_pct 40), 1 = narrow (30)
```

A hash of the mint — not a coin flip, and not position-id parity: it is stable
across restarts, recomputable at analysis time from `token_mint` alone,
uncorrelated with market regime (which time- or sequence-based assignment is
not), and impossible to nudge after the fact. No schema change is needed.

Scope, deliberately narrow:

- **Meme/core sleeve only.** Micro, majors and follow-chain legs are excluded —
  each has its own planner or sizing rules and would add variance for nothing.
- **Both arms keep everything else identical**: shape (BidAsk), `max_down_pct`,
  `fib_bottom`, all P0/P1/P2/P3/P5 thresholds, sizing, gates, rent budget.
- **Tranche second legs inherit their parent's arm**, so a token is never split
  across arms.

## What is being measured

Per closed position, from columns that already exist — no new instrumentation,
which is the point of doing this after the marks programme rather than before:

| metric | expression |
|---|---|
| cost basis | `COALESCE(open_cost_sol, entry_sol)` |
| fee yield | `(fees_measured_sol + fees_at_close_sol) / cost` |
| **net return (primary)** | `REALIZED_PNL_SQL / cost` |
| depth actually used | `MIN(position_marks.price) / entry_price − 1` |
| exit mix | `exit_reason` counts per arm |

Pooled per arm and **capital-weighted** (`SUM(pnl) / SUM(cost)`), never averaged
per position — a 0.15 SOL position and a 0.75 SOL position do not get equal
votes. Use `REALIZED_PNL_SQL` from `src/db/db.ts`; do not reimplement the PnL
expression for this analysis.

## Stopping rule

Stop when **both arms have 40 closed positions, of which at least 15 per arm
traded below −20%.**

40/arm is roughly 8 days at the observed ~10 entries/day. The second condition
is the one that will bind and it is not optional: width only bites on positions
that go down, and 59.7% of the book never reaches −20% at all. Without it the
test can hit its count having barely exercised the treatment.

Do not stop early on a favourable interim read. Do stop early on the abort
condition below.

## The rule

**Ship `min_down_pct = 30` only if ALL THREE hold:**

1. `net_return(narrow) − net_return(control) ≥ +1.0pp` of deployed capital,
   capital-weighted; and
2. `fee_yield(narrow) ≥ fee_yield(control)` — the entire mechanism of the
   hypothesis is that concentrated capital earns more fees. If returns improve
   while fee yield does not, the cause is something else and this is the wrong
   change to ship; and
3. combined realized loss from `P1_stop` + `P0_safety` per SOL deployed is **not
   worse in the narrow arm by more than 0.5pp**.

If (1) fails, keep 40. **If (1) and (2) pass but (3) fails, the follow-up is
reworking P1 — not shipping the width anyway.** Narrower ranges convert to
inventory faster, so `value_frac` decays faster and the same price path trips the
0.75 stop sooner. That is the identical failure mode `RANGE-SHAPE-DECISION.md`
identified for Spot, arriving through a different door.

**Abort early and revert both arms to 40 if**, at any 48h check, the narrow arm's
cumulative net is **0.15 SOL or more below** the control arm's. Do not wait for
the count.

## Prior, stated in advance

I expect this to **fail**, and that is worth writing down before the numbers
exist so that a null result is not quietly reframed as a surprise.

Narrowing moves three exits at once, all in the "leave sooner" direction:
`P5_below` and the escape hatch arm at shallower absolute drawdowns, and P1's
`value_frac` decays faster because a narrower range converts to inventory
faster. `RANGE-SHAPE-DECISION.md` measured P1 stops as the tax (−0.55 SOL over 8)
and the give-back study found that of 25 positions green-then-red, **zero**
returned to break-even. The hypothesis is that concentration beats those costs.
The prior is that it does not.

The reason to run it anyway is that 28.3% median utilisation is a large, real,
measured inefficiency, and the only alternative explanation on offer — that deep
BidAsk bins are cheap insurance — is already contradicted by the −55..−80% band's
30% win rate.

## Data-integrity checks (run at 48h; if any fails the clock resets)

**(a) The arms are balanced and drawn from the same population.**

```sql
SELECT arm, COUNT(*) n, ROUND(AVG(score),1) mean_score, ROUND(AVG(entry_sol),4) mean_size
  FROM positions_with_arm WHERE entry_ts > <start_ts> GROUP BY arm;
```

Pass: counts within 30% of each other, mean entry score within 3 points, mean
size within 15%. Divergence here means assignment is leaking into *admission* —
most likely via the rent gate, since a narrower plan needs fewer bin arrays and
so passes `bin_rent` where a wider one is rejected. **If that is happening the
experiment is measuring the gate, not the width**, and the fix is to evaluate the
rent gate at a fixed reference width for both arms.

**(b) Realized depth distributions overlap.**
Pass: the share of each arm reaching −20% is within 10pp. If the narrow arm's
positions systematically go less deep, the arms are not comparable and (a) is
lying.

**(c) Escape-hatch arming rate is equal across arms.**
Pass: arming rates within 5pp. This is the prerequisite's regression test. If it
fails, the absolute-terms conversion did not hold and the whole run is void.

**(d) The book has not deteriorated while running.**
Pass: total net over the window `> −0.15 SOL`. Nothing in a width test should
produce worse than that; it would mean width is not the binding constraint and
the run should stop regardless of which arm is ahead.

## Do not, while running

- **Do not touch `max_down_pct`.** It is not the width lever — `min_down_pct` is
  applied last as a hard floor and binds on the large majority of entries (median
  planned depth −42.1% against a 40% floor). Changing `max_down_pct` will look
  like it does nothing, and will contaminate the one arm it does move.
- **Do not widen toward −75% on the strength of the source post.** 0 of 176
  positions have traded there, 12 of the 13 that passed −50% were already closed
  by P0/P1, and a −75% range is ~138 bins at binStep 100 and ~174 at binStep 80 —
  at or past what `max_position_accounts = 2` allows, at ~3 bin arrays of
  non-refundable rent against `bin_rent_budget_sol = 0.075` and the
  25%-of-position rent cap. Our own rent gate would reject most such plans before
  P0 ever became relevant.
- **Do not re-tune `bin_rent_budget_sol`.** It changes how often
  `fitPlanToRentBudget` shrinks a plan, which changes realized width in both arms
  — the exact confound (2) that this design exists to remove.
- **Do not change P1/P3/P5 or the escape hatch mid-run**, including the
  prerequisite conversion. Land it, verify a week of unchanged exits, then start.
- **Do not judge on fee yield alone.** The 26 positions that reached −40% earned a
  **15.21%** fee yield and still returned **−0.82%** at a 38% win rate. Fees are
  not the objective; kept SOL is.
- **Do not use `npm run sim` to shortcut this.** The backtester replays closed
  positions against alternative *exit* settings. Width is an entry decision, and
  `src/sim/` explicitly cannot simulate entries, gates or sizing. There is no
  offline version of this test.
- **Do not run it on Railway.** Its book is smaller and it is the production bot;
  the server carries the sample and is the staging target.

## Status

**2026-08-25 — not started.** Blocked on the escape-hatch prerequisite, which is
now built but **off** (`escape_hatch_absolute`), pending live disagreement data —
see the addendum above. No width knob has been touched.
