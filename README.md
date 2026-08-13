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
│   ├── scan.ts        sweep → dedupe → best-pool → gates → score
│   ├── majorsScan.ts  majors discovery + whitelist merge          (§1.1)
│   └── majorsGates.ts relaxed gates for majors sleeve             (§1.1)
├── vetting/
│   ├── rugcheck.ts    RugCheck veto layer                         (§2.2)
│   ├── onchain.ts     fresh RPC authorities                       (§2.2)
│   ├── holders.ts     AMM-stripped concentration                  (§2.2)
│   ├── clusters.ts    funding-cluster + launch-slot snipers       (§2.2)
│   ├── jupdata.ts     Jupiter organic/bot/dev into soft score
│   └── vet.ts         hard gates + soft score + blacklisting
├── ranges/
│   ├── planner.ts     fib-anchored bid-ask + follow-range bins    (§3)
│   └── majorsPlanner.ts spot range + RSI/swing entry timing       (§1.1)
├── risk/
│   ├── limits.ts      Kelly (measured PnL), slots, breaker, regime (§5)
│   ├── sleeve.ts      micro/meme/majors sleeve tagging + exposure
│   ├── micro.ts       micro sleeve caps                           (§1.1)
│   ├── majors.ts      majors slot budget + deploy cap             (§1.1)
│   └── majorsManage.ts majors-specific manage overrides            (§1.1)
├── executor/
│   ├── executor.ts    Executor interface (manager is mode-blind)
│   ├── paper.ts       simulated fills/fees vs live pool data      (§8)
│   ├── live.ts        @meteora-ag/dlmm + Zap SDK / Jupiter zap-out   (§3.6)
│   ├── jupiter.ts     manual Jupiter lite swap (fallback)
│   ├── zap.ts         Meteora Zap SDK → Jupiter V6 when use_zap
│   └── wallet.ts      keypair load
├── manager/
│   ├── loop.ts        P0–P5 + entry pipeline + majors entry        (§4)
│   ├── majorsEntry.ts majors spot entry after meme pipeline       (§1.1)
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
run a second loop against the same wallet. Full checklist: [STRATEGY.md §10](STRATEGY.md#10-roadmap-checklist-2026-08-13).

**Built:** live DLMM executor (Zap SDK + manual fallback), wallet-delta PnL, P0–P5,
escape hatch, follow mode, GMGN holder-watch P0, smart-money scoring, funding-
cluster/sniper vetting, cluster brake, open slippage fix, range-shape
instrumentation, three-tier sleeves (micro / meme / majors), residual sweep,
Telegram + heartbeat, auto-deploy.

**Do not ship (decided):** meme BidAsk→Spot/Curve ([RANGE-SHAPE-DECISION.md](RANGE-SHAPE-DECISION.md)),
SOL-USDC/stable pairs, weaken P1, house-money, more slots.

**Deferred:** meme compound/hybrid fee dest, weight auto-tuning, RugCheck
paid WS, multi-wallet sharding, majors continuous Kelly.

**Monitor:** post-fix book sample, first majors entries, Kelly fraction, mark
gaps on new positions.

## Disclaimer

LPing memecoins is extremely high risk. This software can lose all funds it
controls. Nothing here is financial advice; use at your own risk.
