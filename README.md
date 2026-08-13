# meteora-farmer

Automated **Meteora DLMM** liquidity bot for Solana.

It finds busy SOL-quoted meme pools, checks the token isn’t an obvious rug, opens a **one-sided SOL** LP position below price, then exits by fixed rules. Everything is logged in SQLite.

**Start in paper mode.** Paper needs no wallet and spends no SOL. Live trading is locked behind two separate switches on purpose.

| | |
|---|---|
| Strategy deep-dive | [STRATEGY.md](STRATEGY.md) |
| Knobs that actually run | [config.toml](config.toml) |
| Risk | This can lose **100%** of funds in the wallet. Not financial advice. Burner only. |

---

## Contents

1. [What it does](#what-it-does)
2. [Before you start](#before-you-start)
3. [Install & run (paper)](#install--run-paper)
4. [Commands you’ll use](#commands-youll-use)
5. [Optional dashboard](#optional-dashboard)
6. [Going live](#going-live) ← includes private key, RPC, Jupiter
7. [Keep it running (PM2)](#keep-it-running-pm2)
8. [Troubleshooting](#troubleshooting)

---

## What it does

```text
every ~60s          every ~15s
───────────         ──────────
scan pools    →     manage open LPs
filter + score            ↓
vet token           claim / reclaim / exit
size position             ↓
open LP             record PnL in SQLite
```

**In plain English**

- **Scan** — pull hot Meteora pools
- **Filter** — skip junk (TVL, fees, age, mcap, …)
- **Vet** — rug / holder / authority checks
- **Open** — put SOL into a bid-ask range under the price
- **Manage** — mechanical exits (stop, safety, above/below range, etc.)
- **Paper vs live** — same brain; paper fakes fills, live uses your burner wallet

Three size “sleeves”: **micro** (tiny caps), **meme** (main), **majors** (allowlisted alts, spot range). Details in [STRATEGY.md](STRATEGY.md).

---

## Before you start

Install these first:

| Need | Link | Check |
|---|---|---|
| **Node.js 20+** | [nodejs.org](https://nodejs.org) (LTS) | `node -v` → `v20…` or higher |
| **Git** | [git-scm.com](https://git-scm.com) | `git --version` |
| A terminal | PowerShell / Terminal / bash | — |

You do **not** need a wallet, RPC key, or Jupiter key for paper mode.

---

## Install & run (paper)

Do these in order. Stay in paper until you’re comfortable.

### 1. Download the repo

```bash
git clone https://github.com/CryptoGnome/meteora-farmer.git
cd meteora-farmer
```

### 2. Install packages

```bash
npm install
```

Wait for it to finish. A message about `better-sqlite3` compiling is normal.

### 3. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` in Notepad / VS Code / nano. For paper, you only need:

```env
FARMER_MODE=paper
RPC_URL=https://api.mainnet-beta.solana.com
```

Leave wallet keys empty.

**Rules**

- Never commit `.env`
- Never paste keys into Discord, Telegram, or screenshots
- Never use your main wallet for this bot

### 4. Confirm config is paper

Open `config.toml`, find `[exec]`, set:

```toml
[exec]
mode = "paper"
```

If it already says `"live"`, change it to `"paper"`.

> Live only runs when **both** `config.toml` and `.env` say live. One alone is not enough.

### 5. Smoke test (optional)

```bash
npm run scan
```

You should see candidates (or an empty list if markets are quiet).

```bash
npm run vet -- PASTE_A_TOKEN_MINT_HERE
```

### 6. Start paper trading

```bash
npm run run
```

Leave that window open.

In a **second** terminal in the same folder:

```bash
npm run status
```

### 7. Stop

```bash
npm run halt
```

Or press `Ctrl+C` in the `run` window (fine for paper).

---

## Commands you’ll use

```bash
npm run scan                 # show pools that pass gates right now
npm run vet -- <mint>        # full vet report for one token
npm run run                  # start the bot loop
npm run status               # open positions + profit
npm run halt                 # close all + stop (politely)
npm run force-close -- <id>  # force-close one position id
npm test                     # run tests
```

---

## Optional dashboard

Local web UI for positions, activity, and settings.

**1.** Add to `.env`:

```env
DASH_TOKEN=pick-a-long-random-password
DASH_PORT=8787
```

**2.** Build once:

```bash
npm run dash:build
```

**3.** Start:

```bash
npm run dash
```

**4.** Open [http://localhost:8787](http://localhost:8787) and enter the same `DASH_TOKEN`.

On your LAN: `http://YOUR_PC_IP:8787`.

---

## Going live

Only after paper feels boring and you understand the exits.

Live spends **real SOL**. Use a **burner** wallet funded with money you can lose completely.

### Live checklist

- [ ] Paper ran cleanly for a while  
- [ ] Fresh burner wallet (not your main)  
- [ ] Private RPC URL  
- [ ] Jupiter API key  
- [ ] Private key in `.env` (or keypair file path)  
- [ ] `config.toml` → `mode = "live"`  
- [ ] `.env` → `FARMER_MODE=live`  
- [ ] Only **one** farmer process on that wallet  

---

### How to get a burner wallet + private key

#### Option A — Phantom (easiest)

1. Install [Phantom](https://phantom.app).
2. Create a **new** wallet (or a new account inside Phantom).  
   Do **not** use the wallet that holds your life savings.
3. Send only the SOL you are willing to lose to that address.
4. Export the private key:
   - Open Phantom → select that account  
   - **Settings** → **Security & Privacy** → **Export Private Key**  
   - Enter your password  
   - Copy the key (long base58 string)
5. Paste into `.env`:

```env
WALLET_PRIVATE_KEY=paste_the_key_here_with_no_quotes_no_spaces
```

6. Close the export screen. Don’t leave it open. Don’t screenshot it.

#### Option B — Solana CLI keypair file

```bash
solana-keygen new --outfile ./burner.json
```

Put the path in `.env` instead of the base58 key:

```env
WALLET_KEYPAIR_PATH=./burner.json
```

Fund the pubkey printed by `solana-keygen`.  
If **both** `WALLET_PRIVATE_KEY` and `WALLET_KEYPAIR_PATH` are set, the base58 key wins.

---

### How to get a private RPC

Public `api.mainnet-beta.solana.com` is fine for a paper smoke test. Live opens/closes will fail or lag on it.

1. Sign up at a provider (examples: [Helius](https://www.helius.dev), [QuickNode](https://www.quicknode.com), FluxRPC, etc.).
2. Create a **Solana mainnet** endpoint.
3. Copy the HTTPS URL into `.env`:

```env
RPC_URL=https://your-provider-url-here
```

Optional backup for the watchdog:

```env
RPC_URL_FALLBACK=https://your-backup-url-here
```

---

### How to get a Jupiter API key

Needed in live for swaps / zap-out.

1. Go to [portal.jup.ag](https://portal.jup.ag).
2. Create an account / API key (free tier is enough to start).
3. Put it in `.env`:

```env
JUPITER_API_KEY=your_key_here
```

---

### Optional: Telegram alerts

1. In Telegram, talk to [@BotFather](https://t.me/BotFather) → `/newbot` → copy the bot token.  
2. Talk to [@userinfobot](https://t.me/userinfobot) → copy your chat id.  
3. Message your new bot once so it can DM you.  
4. Add to `.env`:

```env
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654321
```

Optional discovery enrichment (bot works without it):

```env
GMGN_API_KEY=
```

---

### Flip the two live switches

**`.env`**

```env
FARMER_MODE=live
RPC_URL=https://your-private-rpc
JUPITER_API_KEY=your_key
WALLET_PRIVATE_KEY=your_burner_key
```

**`config.toml`**

```toml
[exec]
mode = "live"
```

Then:

```bash
npm run run
```

To go back to paper: set **both** back to `paper`, and remove or comment the wallet key if you want extra safety.

---

## Keep it running (PM2)

Only after `npm run run` works by hand.

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.cjs --only meteora-farmer
pm2 save
pm2 logs meteora-farmer
```

Same file can also start:

- `meteora-dash` — dashboard server  
- `meteora-deploy` — auto-pull when `master` updates (server installs)

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| `node -v` too old | Install Node 20+, close and reopen the terminal |
| `npm install` fails on `better-sqlite3` | Windows: install “Desktop development with C++” (VS Build Tools). Linux: `sudo apt install build-essential python3` |
| Scan/run flooded with RPC errors | Put a private RPC in `RPC_URL` |
| “Already running” / lock file | Make sure no other `run` is open. Only if you’re sure: `npm run release` |
| Dashboard blank / unauthorized | Set `DASH_TOKEN`, run `dash:build`, then `dash`, use the same token in the browser |
| Thought it was paper but it traded | Check **both** `[exec].mode` in `config.toml` **and** `FARMER_MODE` in `.env` |
| Opens fail in live | Jupiter key set? Private RPC? Burner funded with SOL + a little for fees? |

---

## Folder map

```text
src/            bot code
dashboard/      web UI
deploy/         dashboard server + PM2 + auto-deploy
config.toml     strategy settings (hot-reloads)
.env.example    copy → .env
data/           SQLite DB (created on first run)
STRATEGY.md     full design doc
```

---

## Disclaimer

Provided as-is. Memecoin LP is extreme risk. You can lose everything under this bot’s control. Authors owe you nothing if a wallet gets wrecked. Paper first. Burner only. Don’t be a hero.
