# meteora-farmer

**Automated Meteora DLMM liquidity farmer for Solana.**

Scans hot SOL-quoted meme pools, vets the token, opens **one-sided SOL bid-ask** positions below price, then manages each position with a strict exit machine. PnL is tracked in SQLite. **Paper mode is the safe default path** — live trading is double-locked behind config *and* env.

> LPing memecoins can wipe a wallet. This bot can lose every SOL you give it. Nothing here is financial advice. Use a burner wallet. Never put rent money in it.

---

## What it does

```text
scan pools  →  gate + score  →  vet token  →  size (Kelly)  →  open LP
                                                              ↓
                         manage every ~15s (P0–P5 exits, claims, reclaim)
                                                              ↓
                                              close → bank PnL in SQLite
```

| Piece | Job |
|---|---|
| **Scanner** | Sweeps Meteora DLMM pools on a timer; picks the best pool per token |
| **Gates + score** | Hard filters (TVL, fees, mcap, …) then a 0–100 opportunity score |
| **Vetting** | RugCheck / holders / clusters / on-chain authorities — veto rugs |
| **Entry** | Fib-anchored bid-ask below spot (meme/micro); spot range for majors |
| **Manager** | Mechanical exits: safety, stop, rotation, above/below range, escape |
| **Executor** | Paper = simulated fills · Live = real `@meteora-ag/dlmm` + Jupiter zap |
| **Ledger** | SQLite (`data/farmer.db`) — positions, marks, decisions, events |
| **Dashboard** | Optional LAN UI (`:8787`) for book / activity / settings |

### Three sleeves

| Sleeve | Who | Shape | Notes |
|---|---|---|---|
| **micro** | mcap ~$100k–$200k | BidAsk | Smaller size, tighter caps |
| **meme** | mcap ≥ ~$200k | BidAsk | Main strategy |
| **majors** | allowlisted alts | Spot | Separate timing + manage rules |

Full strategy spec (every knob): **[STRATEGY.md](STRATEGY.md)**  
Live knobs (hot-reloaded): **[config.toml](config.toml)**

---

## Requirements

Before you touch anything, install these:

1. **Node.js 20 or newer** — [https://nodejs.org](https://nodejs.org) (LTS is fine)
2. **Git** — [https://git-scm.com](https://git-scm.com)
3. A terminal (PowerShell, macOS Terminal, or Linux shell)
4. (Optional later) A **burner** Solana wallet + a decent RPC (Helius / similar) for live mode

Check Node works:

```bash
node -v
# should print v20.x or higher
```

---

## Install (idiot-proof)

Do these steps **in order**. Do not skip. Do not start with live mode.

### Step 1 — Get the code

```bash
git clone https://github.com/CryptoGnome/meteora-farmer.git
cd meteora-farmer
```

### Step 2 — Install dependencies

```bash
npm install
```

Wait until it finishes with no red errors.  
(`better-sqlite3` compiles a native module — that is normal.)

### Step 3 — Create your `.env`

```bash
cp .env.example .env
```

Open `.env` in a text editor. For a first run, leave it mostly empty and keep:

```env
FARMER_MODE=paper
RPC_URL=https://api.mainnet-beta.solana.com
```

You do **not** need a wallet key for paper mode.

> Never commit `.env`. Never paste private keys into chat, Discord, or screenshots.

### Step 4 — Force paper mode in config

Open `config.toml`, find `[exec]`, and set:

```toml
[exec]
mode = "paper"
```

If this file already says `mode = "live"`, change it to `"paper"` until you know what you are doing.

### Step 5 — Sanity checks (optional but smart)

```bash
npm run scan
```

You should see pool candidates (or a quiet empty list if markets are dead). Errors about RPC? Switch `RPC_URL` to a private RPC.

```bash
npm run vet -- <TOKEN_MINT_ADDRESS>
```

Replace `<TOKEN_MINT_ADDRESS>` with a real mint. You should get a vetting report.

### Step 6 — Start the farmer (paper)

```bash
npm run run
```

Leave this terminal open. The bot will scan, maybe open paper positions, and manage them.

In another terminal (same folder):

```bash
npm run status
```

### Step 7 — Stop safely

In a third terminal:

```bash
npm run halt
```

That tells a running farmer to close out and stop.  
Or press `Ctrl+C` in the `npm run run` window if you just want to kill the process (paper is fine either way).

---

## Everyday commands

| Command | What it does |
|---|---|
| `npm run scan` | One-shot: show candidates that pass pool gates |
| `npm run vet -- <mint>` | One-shot: full vet report for one token |
| `npm run run` | Start the loop (paper or live, depending on gates) |
| `npm run status` | Open positions + realized PnL |
| `npm run halt` | Ask the running farmer to close all + stop |
| `npm run force-close -- <id>` | Force-close one position by id |
| `npm test` | Run the test suite |
| `npm run typecheck` | TypeScript check |

---

## Optional: LAN dashboard

1. Put a long random secret in `.env`:

```env
DASH_TOKEN=change-me-to-something-long-and-random
DASH_PORT=8787
```

2. Build the UI once:

```bash
npm run dash:build
```

3. Start the API + UI:

```bash
npm run dash
```

4. Open `http://localhost:8787` (or your machine’s LAN IP `:8787`) and paste the same `DASH_TOKEN` when asked.

---

## Optional: keep it running with PM2

Only after paper mode works by hand:

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs --only meteora-farmer
pm2 save
pm2 logs meteora-farmer
```

Also in that file: `meteora-dash` (dashboard) and `meteora-deploy` (auto-pull from `master` on the server). Start those only if you want them.

---

## Going live (dangerous)

Live mode spends real SOL. Read this twice.

### Double gate (both required)

1. `config.toml` → `[exec] mode = "live"`
2. `.env` → `FARMER_MODE=live`

If either is not `live`, it stays paper / refuses live execution.

### Also required for live

| Item | Why |
|---|---|
| `WALLET_PRIVATE_KEY` **or** `WALLET_KEYPAIR_PATH` | Burner wallet only |
| Decent `RPC_URL` | Public RPC will rate-limit and fail opens/closes |
| `JUPITER_API_KEY` | Zap-out / swaps ([portal.jup.ag](https://portal.jup.ag)) |
| Funded burner | Only SOL you can **fully** afford to lose |

Optional: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` for alerts, `GMGN_API_KEY` for discovery enrichment.

### Live checklist

- [ ] Paper loop ran cleanly for a while
- [ ] `[exec].mode` and `FARMER_MODE` both set deliberately
- [ ] Burner wallet, not your main
- [ ] Private RPC configured
- [ ] Jupiter key set
- [ ] You understand exits are mechanical — the bot will cut losers
- [ ] Only **one** farmer process against that wallet/DB (second loop = pain)

Then:

```bash
npm run run
```

---

## Safety model (short)

- **Paper by default path** — no wallet needed
- **Live is double-gated** — config + env must both say live
- **Wallet keys** are only read by the live executor (not scanner/vetting)
- **Single-instance lock** — one `run` per checkout/DB
- **Capital preservation first** — strict exits beat “diamond hands”

---

## Repo map

```text
src/           farmer code (scanner → vet → entry → manage → executor)
dashboard/     React SPA for the LAN ops UI
deploy/        dashboard server, auto-deploy, PM2 ecosystem
config.toml    all strategy knobs (hot-reloaded)
.env.example   env template (copy to .env)
data/          SQLite DB + runtime files (created on first run)
STRATEGY.md    full strategy specification
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `node -v` too old | Install Node 20+ and reopen the terminal |
| `npm install` fails on `better-sqlite3` | Install build tools (VS Build Tools on Windows, `build-essential` on Linux) |
| Scan/run spam RPC errors | Use a private RPC in `.env` |
| “Already running” / lock errors | `npm run release` only if you are sure no other farmer is live |
| Dashboard won’t open | Set `DASH_TOKEN`, run `npm run dash:build`, then `npm run dash` |
| Thought it was paper but it traded | Check **both** `config.toml` `[exec].mode` and `FARMER_MODE` |

---

## Docs

- [STRATEGY.md](STRATEGY.md) — full system + exit priorities
- [config.toml](config.toml) — what actually runs
- [RANGE-SHAPE-DECISION.md](RANGE-SHAPE-DECISION.md) — why meme stays BidAsk

---

## Disclaimer

This software is provided as-is. Memecoin LP is extreme risk. You can lose 100% of funds under this bot’s control. Authors and contributors owe you nothing if it bricks a wallet. Run paper first. Use a burner. Don’t be a hero.
