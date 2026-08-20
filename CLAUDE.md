# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Automated Meteora DLMM LP bot for Solana ("DLMM Bot", npm name `dlmmbot`): scans hot SOL-quoted meme pools, vets tokens, opens one-sided SOL bid-ask positions below price, and exits by mechanical rules. Paper mode by default; live trading is double-gated (`[exec].mode = "live"` in config **and** `FARMER_MODE=live` env). Memecoin LP is high-risk — never weaken safety gates without being asked.

**STRATEGY.md is the source of truth for strategy behavior.** Every `[bracketed]` default there maps to a key in `config.toml` (hot-reloaded at runtime, no restart needed).

## Commands

```bash
npm run typecheck        # tsc --noEmit — CI gate; the server only deploys typecheck-passing commits
npm test                 # vitest run --coverage (coverage thresholds enforced, see vitest.config.ts)
npx vitest run src/ranges/planner.test.ts   # single test file
npm run test:watch

npm run scan             # one scanner sweep, prints candidates + closest rejects
npm run vet -- <mint>    # vet a single token
npm run sim -- --help    # replay closed positions against alternative EXIT settings (src/sim/)
npm run run              # start the bot loop (see "One instance only" below)
npm run status           # open/closed positions, PnL, paper→live promotion scoreboard
npm run halt / pause / release / force-close

npm run dash             # ops dashboard server (deploy/dashboard-server.mjs, port 8787, needs DASH_TOKEN)
npm run dash:build       # build the React dashboard (dashboard/)
npm run docs:build       # VitePress docs (docs-site/ → writes into docs/setup/)
```

Tests run single-file-serially (`fileParallelism: false`) with a forked pool; unit tests use in-memory DBs plus helpers in `src/test/` (`fakeExecutor.ts`, `config.ts`, `db.ts`, `pool.ts`) and `resetManagerStateForTests()` for the loop's in-memory timers.

## Architecture

Pipeline: **scan → vet → enter → manage → exit**, all driven by the tick loop in `src/manager/loop.ts` (the largest and most central file — it implements the P0–P5 exit state machine from STRATEGY.md §4, watchdog, HALT/PAUSE files, residual sweep, heartbeat).

- `src/scanner/` — Meteora datapi sweep (`meteora.ts`), hard pool gates (`gates.ts`), opportunity score (`score.ts`), GMGN trending/smart-money feeds (`gmgn.ts`, `smartflow.ts`), majors discovery (`majorsScan.ts`, `majorsGates.ts`).
- `src/vetting/` — token hard gates: RPC on-chain checks (`onchain.ts`), holder concentration (`holders.ts`), insider/funding clusters (`clusters.ts`), RugCheck veto (`rugcheck.ts`). RugCheck free API is keyless but rate-limited (~10 rapid calls → 429); it's a **veto layer only**, never approval.
- `src/ranges/` — bin range planners: `planner.ts` (meme BidAsk), `majorsPlanner.ts` (Spot), `binRent.ts` (non-refundable bin-array rent budget gate).
- `src/risk/` — Kelly sizing, circuit/cluster brakes, regime factor (`limits.ts`); three sleeves: `micro.ts`, `sleeve.ts`, `majors.ts`/`majorsManage.ts`. Sleeve is recorded at entry and drives sizing + manage rules.
- `src/executor/` — `Executor` interface (`executor.ts`) with two implementations: `paper.ts` (simulated fills) and `live.ts` (real transactions via Meteora zap SDK + Jupiter swaps). `profitBurn.ts` implements the 1% GNME buy-and-burn fee on live winning closes. **The live executor has had minimal funded testing — treat changes to it with extreme care.**
- `src/sim/` — offline backtester behind `npm run sim`: replays `position_marks` through the mark-derivable half of the exit ladder (`ladder.ts`) under a config overlay, and scores the result with guards that reject one-row wins, thin samples, books that disagree and non-monotonic sweeps (`report.ts`). It reports a **fidelity** number first — how much of real history the replay reproduces — because a model that cannot re-derive the past cannot be trusted about an alternative one. It can never simulate entries, gates, sizing, or the P0/P2 triggers that need TVL and volume.
- `src/db/db.ts` — better-sqlite3 ledger (`data/farmer.db`): positions, decisions, blacklist, errors. Realized PnL is computed by the shared `REALIZED_PNL_SQL` expression — reuse it, don't reimplement PnL math.
- `src/config.ts` — typed mirror of `config.toml` + hot-reload watcher. Runtime config/env/db live under `data/` (or the dir of `FARMER_DB_PATH`); repo `config.toml` is only a template copied on first run. The `Config` interface must stay in sync with `config.toml` keys.
- `dashboard/` — React + Vite + Tailwind ops dashboard (separate package). Served read-only against `farmer.db` by `deploy/dashboard-server.mjs`, which also handles settings writes, the setup wizard, and encrypted wallet management. The **Wiki tab** (`dashboard/src/wiki/content.ts`) is the operator-facing mirror of STRATEGY.md.
- `deploy/` — PM2 ecosystem (bot + auto-deploy watcher + dashboard), Railway start script, heartbeat check.
- `docs/` — published site (dlmmbot.com): marketing `index.html` is hand-edited; `docs/setup/**` is VitePress build output from `docs-site/` (edit markdown there, then `npm run docs:build`).

## Commit workflow (from .cursor/rules/ — applies here too)

1. **Auto-commit + push when a task is done** — don't wait to be asked. Concise message, why > what. Exceptions: user said not to, mid-flight task, or diff is only scratch/secret files.
2. **Docs sync in the same commit** — if the diff changes user-facing behavior, setup, env vars, strategy knobs, or dashboard features, update the matching surfaces: `docs/index.html` (marketing), `docs-site/` markdown (setup), `dashboard/src/wiki/content.ts` (ops Wiki), `llms.txt`/`llms-full.txt`, `README.md`, `STRATEGY.md`. Surgical edits only.
3. **Wiki sync** — any change to scanning, sleeves, entry/exit rules, sizing/brakes, HALT semantics, or dashboard tab meaning must update the Wiki tab content in the same commit.
4. **After pushing, watch CI** — `gh run list --commit $(git rev-parse HEAD)` then `gh run watch <id> --exit-status`; fix until green before declaring done. Never force-push main.

## Operational cautions

- **One bot instance per wallet/DB.** The loop holds `data/farmer.lock`. On Windows, killing a background `npm run run` kills only the npm wrapper — the `tsx` child survives and keeps trading. Kill every node process whose CommandLine matches the repo path, then delete `data/farmer.lock`.
- The bot normally runs on the user's server (PM2 + auto-deploy watcher polling `origin/main` or `origin/develop` via `DEPLOY_BRANCH` every 30s). Local workflow: push to **develop** for staging, merge to **main** + Release workflow for production — see `RELEASE.md`. Do not start a local `npm run run` while the server runs.
- `data/`, `secrets/`, and `.env` are runtime/secret state — never commit them; don't paste keys or `DASH_TOKEN` values into docs.
- Meteora datapi facts (verified): pagination is 1-based; `fee_tvl_ratio` values are already percent; `collect_fee_mode` 0 = fees in both tokens, 1 = quote-only (SOL).
