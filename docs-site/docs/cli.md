---
title: CLI reference
description: Every npm script that matters — scan, vet, run, status, halt, pause, release, force-close, dash — what each prints and when to use it.
---

# CLI reference

All commands run from the repo root. Arguments after the script name need the `--` separator (`npm run vet -- <mint>`).

## Trading loop

### `npm run run`

Starts the bot: the tick loop that scans, vets, enters, manages, and exits. Holds the single-instance lock (`data/farmer.lock`).

- **One instance per wallet/DB — ever.** See [Risk & sizing](./risk#one-instance-per-wallet), including the Windows gotcha where killing `npm` leaves the `tsx` child trading.
- On a server, prefer PM2 (`meteora-farmer` app) so crashes auto-restart — see [Advanced setup](./advanced).
- Restart-safe: on boot it reconciles the DB against the chain (chain wins) and resumes.

### `npm run status`

The at-a-glance report, safe to run any time (read-only):

- Open positions table: id, symbol, entry SOL/price, state, claimed fees, opened time.
- Closed totals: count, **measured** realized PnL in SOL, and how much of that was fee income.
- The **paper→live promotion scoreboard**: consecutive profitable days vs the required 7, per-day realized and unrealized-delta lines, and `ELIGIBLE` when the gate is met.

## Stopping things

### `npm run halt`

Toggles the `HALT` file. First run: the farmer closes **all** positions, swaps to SOL, and idles. Second run: clears HALT so the farmer resumes on the next tick. Same file the dashboard's red HALT button writes.

### `npm run pause`

Toggles the `PAUSE` file — the soft pause. Trading engine OFF, **positions stay open** and watched; run again to turn back ON. Same file as the dashboard header ON/OFF toggle. Use this for "stop making new decisions"; use `halt` for "get me out of everything".

### `npm run blacklist [-- clear <key> [key…]]`

Lists every blacklist entry (token mints and creator addresses, with expiry or `PERMANENT`), or lifts the ones you name. **P0 can be wrong** — a TVL drain on a thin pool looks like a rug — and until this existed there was no way to disagree with a ban short of editing the DB. Lifting a **creator** ban also resets that creator's rug count, because vetting fails `creator_rug_history` on any count above zero and would silently re-ban the creator on its next mint. The dashboard exposes the same thing at `GET /api/blacklist` and `POST /api/blacklist/clear` (re-enter the dash token, same bar as HALT).

### `npm run force-close -- <id> "<reason>"`

Recovery tool for a DB row stuck `open` with **nothing behind it on chain** (the manager refuses to guess about such rows on its own). In live mode it checks the chain first and **refuses** if any tracked position account still exists — it cannot be used to write off a real position. The row's exit values are left NULL on purpose: the outcome is unknown, so it contributes 0 to realized PnL rather than a fabricated number. The command prints the exact undo SQL.

### `npm run release [-- <sol> [note]]`

Returns **banked** SOL (skimmed by profit locks / the retired house-money rule) to the deployable bankroll, through the ledger with a note — not a hand-written DB poke. No argument (or `all`) releases everything banked; a number releases that much. Prints the before/after banked totals and the undo statement.

## Research & diagnosis

### `npm run scan`

One scanner sweep, printed: how many pools were swept, the top candidates with score / fee-TVL / TVL / 30m volume / bin step / base fee / pool address — and when nothing passes (normal in quiet markets), the **closest rejects** with exactly which gate failed and by how much. The fastest way to sanity-check gate settings.

### `npm run vet -- <mint>`

Runs the full vetting engine on a single token and prints the verdict, soft score /100, each hard failure with its value vs limit, and the raw facts JSON (authorities, holders, clusters, RugCheck, age). Use it to answer "why won't the bot touch this token?"

### `npm run sim -- [options]`

Replays closed positions against **alternative exit settings** — the backtest that answers "would a different stop / grace / escape setting have made more SOL on the trades we actually took?"

It reads `position_marks` (one row per 15s manager poll: price, position value, active bin, unclaimed fees) and re-runs the mark-derivable part of the P0–P5 ladder over them with your overrides.

```bash
npm run sim -- --sleeve meme --age-max 120 --set manage.stop_loss_frac=0.65
npm run sim -- --sweep manage.below_range_grace_min=5,10,15,25,40
npm run sim -- --profile aggressive --db server=srv.db --db railway=rw.db
```

**Scenarios**: `--set section.key=value` (repeatable), `--profile <id|path>` (a [profile](./profiles) — exit keys only), `--sweep key=a,b,c` (one run per value).
**Cohort**: `--sleeve`, `--age-max` / `--age-min` (token age at entry, in minutes), `--book`, `--since YYYY-MM-DD`, `--min-marks`, `--include-flagged`.
**Output**: `--list` to see the cohort, `--top N` for per-position rows, `--json <path>` for the full result set.
**Post-exit audit**: `--post-exit [min]` (default 60) answers "did we cut this too early?" — for each exit rule it reports the median high and low price reached after the exit as a multiple of what we sold at, how many rose 25%+ afterwards, how many got back to the entry price (where the whole range is traversed and the position would have converted fully to SOL), and how long the high took to arrive. Needs `npm run sim:backfill` first.

That audit is deliberately about **price, not position value**: valuing an LP position at a future price needs bin-by-bin liquidity and would swap a measurement for a model. Direction, extremes and "did it come back to entry" are enough to see whether an exit rule is systematically early.

Each scenario ends in a **verdict** — `IMPROVES`, `HURTS`, `NOISE`, or `NO-OP` — that a result has to earn. A delta only counts as real if it survives dropping its best two positions, fires on at least 8 positions, and points the same way on every book loaded. That is deliberate: the rule that scored +0.94 SOL in the 2026-08-20 young-launch research turned out to be one position with broken marks.

Two numbers to read before any delta:

- **Fidelity** — how many real exits the replay reproduces from the current config. Below ~85% usually means the exit rules changed since those positions closed (it replays *today's* ladder); re-run with `--since <date of the change>`.
- **Cohort** — how many traces were dropped as unusable, and how many were kept despite exiting by a rule the replay cannot reproduce.

**What it cannot answer.** Marks written before v0.19.1 carry no TVL, pool fee rate or volume, so P0 `tvl_drain` / `pool_dead` / `rugcheck_flip` and P2 fee-volume decay are not simulated — the run reports how much of the cohort now records pool health, and those exit paths become replayable once enough of the book does. Neither are entry gates, vetting or sizing — there is no data for trades the bot never took, so a profile comparison here is about **exit behaviour only**. And because a position's marks stop at its real exit, the replay can evaluate exiting *earlier* far better than exiting *later*.

### `npm run sim:backfill -- [options]`

Fetches the **price path after each closed position** from GeckoTerminal (keyless, rate-limited) into the local DB, so the backtester can judge holding *longer* — not just cutting earlier. A position's own marks stop the moment it closes, which is why this exists.

```bash
npm run sim:backfill                       # fill everything pending
npm run sim:backfill -- --limit 50         # a chunk at a time
```

`--db <path>`, `--window <min>` (default 80, the cap for one API call), `--limit <n>` (default 200), `--pace <ms>` (default 2500), `--refetch`.

It is **resumable and honest about gaps**. Every position attempted gets a row, so a re-run continues where the last stopped, and each ends in one of: `ok`, `too_recent` (the window has not elapsed yet — retried on a later run), `no_bars`, `no_overlap`, `miscalibrated`, or `error`.

**Calibration is the point.** GeckoTerminal is not our price feed, so each fetch also covers the 20 minutes *before* the exit, where we have our own recorded marks, and stores the ratio between the two series. A ratio near 1.0 means the same convention; a tight non-unit ratio is applied as a scale factor; a noisy one marks the position `miscalibrated` and its bars are stored but never used. An external price series is never averaged into a conclusion without first proving it tracks what we measured ourselves.

Then read it back with the audit below.

### `npm run sim:skips -- [options]`

Fetches the **price path after each scanner rejection**, so a gate can be judged on what it actually blocked instead of on intuition. `decisions.outcome_backfill_json` was declared in the first schema with the comment "filled later: what the token did after" and then never written — this fills it.

```bash
npm run sim:skips                              # fill everything pending
npm run sim:skips -- --gate bin_step_new       # investigate one gate
```

`--db <path>`, `--window <min>` (default 90, max 90 — one API call is 100 minute bars), `--limit <n>` (default 200), `--pace <ms>` (default 2500), `--gate <name>`, `--refetch`.

**It fetches per episode, not per sweep.** A rejected pool is re-logged every sweep — one gate accounts for 93% of all skip rows — so rows are grouped into episodes of (mint, pool, gate) per 6 hours and anchored on the first sweep of each. A token blocked for six straight hours costs one API call, and the sweep count is kept alongside the path so a 330-sweep blockade still reads differently from a 2-sweep one. A blockade longer than the bucket is deliberately split, so a 21-hour rejection is sampled several times rather than described by its first minute.

**Backfilled rows survive pruning.** Skip rows are evicted by `pruneHistory`, and on a busy book the size ceiling had been trimming them at ~30 hours against a 30-day age setting — a measurement would be deleted the day after it was fetched. Rows carrying a result are now spared. The set only grows with distinct rejections, not with tick rate.

**It stores the path, not a verdict.** Peak, trough, close, and how many bars traded below the skip price — not "would have hit P0". Thresholds move; measurements should not have to be re-fetched when they do.

Each episode ends in one of: `ok`, `too_recent`, `no_bars`, `no_anchor` (the first bar is more than 10 minutes after the skip, so its open is a different market than the one we rejected), or `error`.

### `npm run heartbeat-check`

Runs the out-of-process liveness checker once by hand (normally it lives in cron). Exit codes: `0` healthy, `1` heartbeat stale/missing (alert sent), `2` the checker itself couldn't read the DB — which deliberately does **not** alert, so a broken checker can't page you about itself.

## Dashboard & docs

| Command | What it does |
|---|---|
| `npm run dash` | Start the ops dashboard server (port 8787, needs `DASH_TOKEN`) |
| `npm run dash:build` | Build the React dashboard bundle (run once before first `dash`, or after UI updates) |
| `npm run docs:dev` | Local VitePress docs dev server |
| `npm run docs:build` | Build these docs into `docs/setup/` |

## Development

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` — the CI gate; the server only deploys typecheck-passing commits |
| `npm test` | Full vitest run with enforced coverage thresholds |
| `npm run test:watch` | Watch mode |

<p class="cta-row">
  <a class="doc-btn ghost" href="./risk">Risk & sizing</a>
  <a class="doc-btn ghost" href="./advanced">Advanced setup</a>
  <a class="doc-btn ghost" href="./dashboard">Dashboard</a>
  <a class="doc-btn ghost" href="./faq">FAQ</a>
</p>
