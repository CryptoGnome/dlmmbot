---
title: CLI reference
description: Every npm script that matters — scan, vet, run, status, halt, pause, release, force-close, dash, simulate-zap — what each prints and when to use it.
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

### `npm run force-close -- <id> "<reason>"`

Recovery tool for a DB row stuck `open` with **nothing behind it on chain** (the manager refuses to guess about such rows on its own). In live mode it checks the chain first and **refuses** if any tracked position account still exists — it cannot be used to write off a real position. The row's exit values are left NULL on purpose: the outcome is unknown, so it contributes 0 to realized PnL rather than a fabricated number. The command prints the exact undo SQL.

### `npm run release [-- <sol> [note]]`

Returns **banked** SOL (skimmed by profit locks / the retired house-money rule) to the deployable bankroll, through the ledger with a note — not a hand-written DB poke. No argument (or `all`) releases everything banked; a number releases that much. Prints the before/after banked totals and the undo statement.

## Research & diagnosis

### `npm run scan`

One scanner sweep, printed: how many pools were swept, the top candidates with score / fee-TVL / TVL / 30m volume / bin step / base fee / pool address — and when nothing passes (normal in quiet markets), the **closest rejects** with exactly which gate failed and by how much. The fastest way to sanity-check gate settings.

### `npm run vet -- <mint>`

Runs the full vetting engine on a single token and prints the verdict, soft score /100, each hard failure with its value vs limit, and the raw facts JSON (authorities, holders, clusters, RugCheck, age). Use it to answer "why won't the bot touch this token?"

### `npm run simulate-zap`

Dry-runs the live exit-swap path — Jupiter V6 quote → build transaction → RPC **simulate** — without moving funds. Requires `JUPITER_API_KEY` and `RPC_URL` in `.env`. Optional `--mint <token_mint> --amount-raw <n>` targets a specific token. Run this before trusting live mode with the zap path.

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
