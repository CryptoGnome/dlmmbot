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
├── cli.ts             entrypoints (scan | vet | run | status | halt)
├── config.ts          typed config.toml loader, hot reload, live-mode double gate
├── types.ts           shared domain types
├── db/db.ts           SQLite schema + blacklist/decision helpers  (§7)
├── scanner/
│   ├── meteora.ts     datapi client (pools sweep, OHLCV)          (§1)
│   ├── gates.ts       pool hard gates                             (§2.1)
│   ├── score.ts       opportunity score parts                     (§2.4)
│   └── scan.ts        sweep → dedupe → best-pool → gates → score  (§1)
├── vetting/
│   ├── rugcheck.ts    free RugCheck API client (veto layer)       (§2.2)
│   ├── onchain.ts     fresh RPC checks (authorities, holders)     (§2.2)
│   └── vet.ts         hard gates + soft score + blacklisting      (§2.2)
├── ranges/planner.ts  fib-anchored bid-ask range → bin IDs        (§3)
├── risk/limits.ts     sizing, slots, circuit breaker, regime      (§5)
├── executor/
│   ├── executor.ts    Executor interface (manager is mode-blind)
│   ├── paper.ts       simulated fills/fees vs live pool data      (§8)
│   └── live.ts        phase 2: @meteora-ag/dlmm + zap-sdk         (§3.6)
└── manager/loop.ts    P0–P5 state machine + entry pipeline        (§4)
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

## Phase 2 (not in scaffold)

Live executor (DLMM + Zap SDK), P0 safety triggers (TVL-drop / wallet-dump /
new-whale), P3 sustain-timer + re-entry ladder + house-money banking, escape
hatch, funding-cluster sniper detection, dashboard, Telegram alerts. All marked
`TODO(phase 2)` in code.

## Disclaimer

LPing memecoins is extremely high risk. This software can lose all funds it
controls. Nothing here is financial advice; use at your own risk.
