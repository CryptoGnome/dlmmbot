# Flat vs adaptive sizing: pre-registered decision rule

**Written 2026-08-26. The gate thresholds below are set before the gate
measurements are run. Do not edit them after looking at the results — that is
the only thing that makes this document worth anything.**

Sibling of `RANGE-WIDTH-DECISION.md` (width) and `RANGE-SHAPE-DECISION.md`
(shape). Those settle *where* capital goes. This one is *how much*, and nothing
else moves with it.

## The question

`sizing.mode` is `kelly`: each position's base is `wallet × f* × kelly_fraction`,
where `f*` is re-estimated from our own rolling closed-position ledger. The
question is whether that adaptation earns its keep, or whether a **constant
fraction** does better.

## What is already measured

Replaying the real `f*` formula over 158 eligible live closes on the server book
— sizing each trade only from closes available *before its own entry*, so there
is no lookahead — against the correct null, which is **a constant fraction equal
to that rule's own mean size**:

| lookback / min_samples | Kelly | constant at same mean | Kelly's timing |
|---|---|---|---|
| 50 / 50 (the old setting) | 0.0795 | 0.0969 | **−18%** |
| 75 / 50 | 0.1052 | 0.1087 | −3% |
| 100 / 25 (shipped 2026-08-26) | 0.1110 | 0.1176 | **−6%** |

Adaptive sizing lost at **every** window tested. A permutation test — shuffling
the same set of sizes across the same set of trades — puts the real pairing ahead
of only **17.6%** of random orderings.

The mechanism is visible directly. Kelly cuts size after losses, but these
outcomes do not run in streaks, so it is small exactly when the next winner
lands. Two of the twelve best trades entered while `appliedFraction` was **0**:

```
EYE     +38.4%   f* = 0.0000  (negative_edge regime)
4680    +14.3%   f* = 0.0000  (negative_edge regime)

mean f* on the 12 best trades : 0.0342
mean f* on everything else    : 0.0359   <- slightly LARGER on the losers
```

The worst of that — the `appliedFraction = 0` shut-offs — was a
`kelly_lookback == kelly_min_samples` artifact and is already fixed
(50/50 → 100/25, commit `5d52562`). **That fix did not resolve this question.**
At 100/25 the timing penalty is smaller but still negative, and still in the same
direction on every window.

## Why that is not enough to ship on

Three reasons, each sufficient on its own.

1. **The replay scores allocation, not book value.** It computes
   `Σ(size_i × ret_i)` holding the wallet constant, with no compounding and no
   slot contention. It answers "did the rule put more money on the better
   trades", which is a strictly weaker question than "would the book be worth
   more".
2. **The set of trades is not fixed under a sizing change.** Size consumes
   `deployableSol` and divides `effectiveSlots` ([limits.ts
   `computeBankroll`](src/risk/limits.ts)). A policy that sizes larger fills the
   book faster and *skips later entries*. The replay cannot see the entries that
   would not have happened. This is the single biggest hole and no offline method
   closes it.
3. **The book is tail-dominated.** The server's entire +1.85 SOL is 10 trades;
   ex-top-10, 208 closes come to −0.01 SOL. Any sizing comparison is really a
   statement about whether those 10 got large allocations, and 158 trades is a
   thin basis for it.

## Disclosure: a preliminary look already happened

This document is not written in ignorance, and pretending otherwise would defeat
its purpose. On 2026-08-26, while investigating a different question, position
size was regressed against per-SOL outcome to test whether small positions were
being eaten by fixed overhead. The result was the opposite of the hypothesis:
**high-overhead (smaller) positions returned +1.34%/SOL against +1.06% for
larger ones.** That was an informal look, not corrected for sleeve, score or
regime, and it is not evidence of anything on its own.

It matters here because it points the *wrong way for the obvious version of this
change*. Gate 1 below exists to test it properly, and its threshold is set
knowing that a first look leaned negative.

## The design flaw in `sizing.mode = "fixed"`

**Do not test this by flipping `sizing.mode` to `fixed`.** It changes two things
at once:

```ts
const mult = score >= 85 ? s.score_mult_high : score >= 70 ? s.score_mult_mid
           : score >= 60 ? s.score_mult_low : 0;
if (mult === 0) return 0;

if (sizingMode() === "fixed") {
  return fixedSleeveSize(sleeve, bankroll.deployableSol, bankroll.walletSol);
}                                    // <- mult gates admission, then is DISCARDED

const base = kellySleeveBase(sleeve, bankroll.deployableSol, kellyBase);
const size = Math.min(base * mult, ...);   // <- Kelly keeps the score tilt
```

Fixed mode drops the **0.5× / 1.0× / 1.5× score tilt** as well as the adaptive
base. That is deliberate and documented (STRATEGY.md §5), but it makes
`mode = "fixed"` a two-variable change, and the width document's rule applies
verbatim: do not ship two levers together.

**The one-variable arm already exists and needs no code.** Inside Kelly mode a
sleeve may choose its own base unit:

```ts
export function kellySleeveBase(sleeve, deployableSol, kellyBase) {
  const unit = s[`kelly_${sleeve}_unit`];
  if (unit === "sol") return s[`kelly_${sleeve}_sol`];
  if (unit === "pct") return deployableSol * (s[`kelly_${sleeve}_pct`] / 100);
  return kellyBase * (s[`kelly_${sleeve}_mult`] ?? 1);
}
```

Setting `kelly_core_unit = "pct"` keeps `sizingMode() === "kelly"` — so
`base * mult` still applies the score tilt, the caps and the floor are untouched
— while making the base a constant share of deployable that **does not respond to
recent outcomes**. Exactly one thing changes.

`"pct"` and not `"sol"`: the claim is *"do not let recent outcomes move the
size"*, not *"do not scale with the bankroll"*. A flat SOL number stops tracking
the wallet and would confound growth with the treatment.

### Calibration (recompute at start; do not copy these numbers)

The arms must have the **same mean size**. The finding is about the *variance* of
sizing, not its level — if the flat arm is simply bigger, the test measures
leverage and answers nothing.

```
kelly_core_pct = 100 × (equity × appliedFraction) / deployableSol
```

Worked on the server, 2026-08-26: equity 26.50, `appliedFraction` 0.05,
banked −0.0664, deployed 2.2434, reserve 3.6500, deployable 20.6730 →
base 1.3250 SOL → **`kelly_core_pct = 6.41`**.

Note the server is currently **cap-bound, not estimate-bound**
(`f* × 0.25 = .0786` clipped by `kelly_max_position_frac = 0.05`), which makes
its Kelly arm *already nearly constant*. See "Do not, while running".

## Gates, in order. Do not skip to the live test.

### Gate 1 — is per-trade % return independent of position size? (free, ledger only)

The counterfactual in "What is already measured" silently assumes `ret_i` does
not depend on `size_i`. If larger positions systematically return less per SOL —
thinner fills, more pool share, worse exits — then reallocating toward winners
does not transfer and the entire premise inverts.

Regress `REALIZED_PNL_SQL / cost` on `log(entry_sol)`, meme/core sleeve only,
controlling for entry score and `fee_tvl_24h` bucket.

- **Pass** (proceed to Gate 2): slope is within ±0.5pp of return per doubling of
  size, or its 95% interval spans zero.
- **Fail** (stop; write it up and close this document): slope is negative beyond
  −0.5pp per doubling. Flattening upward would then be actively harmful, and the
  correct response is the opposite change — *smaller, more numerous* positions —
  which is a different document.

### Gate 2 — how often would a flat rule have been blocked? (free, ledger only)

Replay entries under the calibrated flat rule and count how often the flat size
would have exceeded `deployableSol`, tripped `max_pool_share_pct = 20`, or
reduced `effectiveSlots` below the observed open count.

- **Pass**: blocked or clipped on **< 10%** of entries. The replay's
  fixed-trade-set assumption is then approximately true.
- **Fail**: ≥ 10%. The replay is measuring a policy that could not have run, and
  its −6% number is void. Go to Gate 3 anyway, but strike the replay from the
  evidence.

### Gate 3 — instrumented-off, 14 days, no behaviour change

Precedent: `P1_fee_offset_deferred`, `escape_absolute_deferred`. Log the flat
counterfactual size at every entry as a `sizing_flat_deferred` decision, alongside
the Kelly size actually used. Change nothing.

- **Proceed to Gate 4** only if median `|flat − kelly| / kelly` over the window is
  **≥ 15%**. Below that the two rules are the same rule in production and there is
  nothing to test — record that and close the document.
- This gate also re-measures, live, whether `appliedFraction` still moves at all
  after the 100/25 change. If it sits at the cap, Kelly is already constant.

### Gate 4 — live A/B, only if Gates 1–3 all pass

**Randomised at entry on a pure function of the mint**, same construction as the
width test — stable across restarts, recomputable at analysis time, uncorrelated
with regime, impossible to nudge afterwards:

```
arm(mint) = sha256(mint)[1] & 1     0 = control (kelly base), 1 = flat (pct base)
```

Byte **1**, not byte 0: byte 0 is the width test's assignment. If both ever run
at once they must not be collinear. **They should not run at once.**

Scope: meme/core only. Micro, majors and follow legs excluded — separate sizing
paths. Tranche legs inherit their parent's arm.

**Known interference, stated in advance:** the arms share one wallet, so an
arm-1 position consumes deployable capital that an arm-0 entry might have used.
This is a genuine SUTVA violation and cannot be designed away without two
wallets. Calibrating both arms to the same *mean* size makes the interference
symmetric in expectation, so it inflates variance rather than biasing the
contrast — but that is an argument about expectations, not a guarantee, and it is
the weakest joint in this design.

## Power, computed before starting rather than discovered afterwards

Per-trade return stdev on the eligible book is **7.3pp**. To resolve a difference
in capital-weighted return of 1.0pp with a difference-SE of 0.8pp:

```
n per arm  ≈  (7.3 × √2 / 0.8)²  ≈  167
```

**~167 closes per arm, ~334 total, ~33 days at the observed ~10 entries/day.**

Write that down and mean it: **40 closes will not settle this, and neither will
100.** If the run is stopped early on a favourable read, the result is noise with
a narrative attached. The honest options are to commit to a month or to not start.

## The rule

**Ship `kelly_core_unit = "pct"` only if ALL THREE hold at the stopping point:**

1. `net_return(flat) − net_return(kelly) ≥ +0.75pp` of deployed capital,
   capital-weighted (`SUM(pnl) / SUM(cost)`, never averaged per position); and
2. the flat arm's result **is not carried by one row** — removing its single best
   position leaves the difference ≥ +0.25pp. This is the guard `src/sim/report.ts`
   already applies and the one this book most needs, given ex-top-10 is −0.01 SOL;
   and
3. `P1_stop` + `P0_safety` realized loss per SOL is **not worse in the flat arm by
   more than 0.5pp** — larger positions in the same pools mean more inventory to
   unwind at the stop.

If (1) fails, keep Kelly and record it. If (1) passes and (2) fails, **that is a
null result, not a marginal pass** — say so.

**Abort early and revert both arms if**, at any 48h check, the flat arm's
cumulative net is **0.20 SOL or more below** control. Do not wait for the count.

## Prior, stated in advance

**I expect flat to win slightly, and I expect the test to be inconclusive at any
feasible n.** Both halves are written down deliberately.

The direction is well supported: the timing penalty is negative at every window
tested, the permutation test is unambiguous, and the theoretical reason is sound
— sizing on outcome history only pays if outcomes autocorrelate, and there is no
evidence here that they do.

The magnitude is the problem. At 100/25 the measured penalty is **6%** of an
already-thin edge, and the power calculation says ~334 closes to resolve 1pp.
The most likely honest outcome is *"cannot distinguish"*, and the value of this
document is that such an outcome gets recorded as a null instead of being
re-litigated in three weeks.

If Gate 3 shows the two rules produce near-identical sizes in production, **the
best outcome is closing this document unrun.**

## Do not, while running

- **Do not flip `sizing.mode = "fixed"`.** It moves the score tilt as well —
  see the design-flaw section. That is a separate question and a separate
  document.
- **Do not run this concurrently with the width test.** Both change how much SOL
  sits in which bins; they are not separable after the fact, and their mint-hash
  arms would need to be checked for collinearity even using different bytes.
- **Do not touch `kelly_fraction`, `kelly_max_position_frac`, `kelly_lookback`,
  `kelly_min_samples`, `min_position_sol`, `min_position_pct`, `reserve_sol` or
  `reserve_pct` mid-run.** Every one of them rescales both arms unequally.
- **Do not raise `kelly_max_position_frac` to "give Kelly a fair chance" on the
  server.** It is cap-bound at 0.05 today, which genuinely does compress the
  contrast — but raising a size cap on a book whose entire profit is 10 trades is
  the exact error quarter-Kelly exists to prevent. If the cap compression makes
  the server unusable as a venue, run the test on the bot that is not cap-bound
  and say so, rather than loosening a risk limit to suit an experiment.
- **Do not equalise the caps across bots** (server `kelly_max_position_frac` 0.05,
  Railway 0.10) while this is running. It is a real unintended divergence and it
  should be resolved — on its own, before or after, never during.
- **Do not use `npm run sim`.** It replays closed positions against alternative
  *exit* settings and explicitly cannot simulate entries, gates or sizing. There
  is no offline version of Gate 4.
- **Do not read a favourable first week as a result.** See the power section.

## Status

**2026-08-26 — not started. Gate 1 not yet run.** No sizing knob has been touched
beyond the `kelly_lookback` / `kelly_min_samples` change of the same date, which
is a separate, already-shipped decision. `kelly_core_unit` is `"kelly"` on both
bots.
