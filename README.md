# meteora-farmer

Automated Meteora DLMM LP farmer: scans for high-fee pools, vets tokens against
rug signals, enters one-sided SOL bid-ask positions, manages them through a
strict-priority state machine, and tracks PnL in SQLite. **Paper mode by
default** — live trading is double-gated behind config + env flags.

Full strategy specification: [STRATEGY.md](STRATEGY.md). Every `[bracketed]`
default there maps to a key in [config.toml](config.toml) (hot-reloaded).

## Quickstart

```bash
npm install
cp .env.example .env      # defaults work for paper mode
npm run scan              # one-off: show current candidates passing pool gates
npm run vet -- <mint>     # one-off: full vetting report for a token
npm run run               # start the paper-trading loop
npm run status            # open positions + realized PnL
npm run halt              # toggle HALT (running farmer closes all + stops)
```

## Architecture

```
src/
├── cli.ts             scan | vet | run | status | halt | force-close | release
├── config.ts          typed config.toml loader, hot reload, live-mode double gate
├── types.ts           shared domain types
├── db/db.ts           SQLite schema, REALIZED_PNL_SQL, blacklist (§7)
├── scanner/
│   ├── meteora.ts     datapi client (pools sweep, OHLCV)          (§1)
│   ├── gates.ts       pool hard gates                             (§2.1)
│   ├── score.ts       opportunity score parts                     (§2.4)
│   ├── gmgn.ts        trending + security pre-vet                 (§1)
│   ├── smartflow.ts   GMGN smart-money/KOL flow                   (§1)
│   └── scan.ts        sweep → dedupe → best-pool → gates → score
├── vetting/
│   ├── rugcheck.ts    RugCheck veto layer                         (§2.2)
│   ├── onchain.ts     fresh RPC authorities                       (§2.2)
│   ├── jupdata.ts     Jupiter organic/bot/dev into soft score
│   └── vet.ts         hard gates + soft score + blacklisting
├── ranges/planner.ts  fib-anchored bid-ask + follow-range bins    (§3)
├── risk/limits.ts     Kelly (measured PnL), slots, breaker, regime (§5)
├── executor/
│   ├── executor.ts    Executor interface (manager is mode-blind)
│   ├── paper.ts       simulated fills/fees vs live pool data      (§8)
│   ├── live.ts        @meteora-ag/dlmm + Jupiter zap-out          (§3.6)
│   ├── jupiter.ts     swap-to-SOL + residual sweep helper
│   └── wallet.ts      keypair load
├── manager/
│   ├── loop.ts        P0–P5 + entry pipeline                      (§4)
│   ├── follow.ts      P3-F up-only re-entry chains
│   ├── holderwatch.ts GMGN wallet-dump / new-whale P0
│   └── reconcile.ts   chain wins on live startup
└── pnl/rollup.ts      daily PnL + paper→live promotion
```

## Modes & safety

- `paper` (default): simulates positions against live pool data; nothing
  touches a wallet. Promotion rule: ≥7 days of positive paper PnL (§8).
- `live`: requires **both** `[exec].mode = "live"` in config.toml **and**
  `FARMER_MODE=live` in the environment. Wallet secret comes from
  `WALLET_PRIVATE_KEY` (base58, as exported by Phantom) or
  `WALLET_KEYPAIR_PATH` (solana-keygen JSON); only the live executor reads
  them. Use a dedicated burner wallet funded with an amount you can lose
  entirely.

## Built vs deferred (2026-08-13)

Live on `gn0meserver` since 2026-08-07. Paper promotion is historical; do not
run a second loop against the same wallet.

**Built:** live DLMM executor, wallet-delta PnL, P0–P5, escape hatch, follow
mode, GMGN holder-watch P0, smart-money scoring, Jupiter datapi soft score,
Telegram + out-of-process heartbeat, residual token sweep, range-shape
instrumentation (`position_marks` + per-bin close snapshots).

**Deferred / do not ship yet:** `@meteora-ag/zap-sdk` (manual Jupiter zap-out
is the path), funding-cluster snipers from early tx history, second tranche,
compound/hybrid fee destination, majors-mode parking lot, dashboard, BidAsk→Spot
(see [RANGE-SHAPE-DECISION.md](RANGE-SHAPE-DECISION.md) — sample is large enough
to *evaluate*, not to flip).

## Disclaimer

LPing memecoins is extremely high risk. This software can lose all funds it
controls. Nothing here is financial advice; use at your own risk.
