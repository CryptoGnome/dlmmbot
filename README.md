# DLMM Bot

Automated **Meteora DLMM** liquidity bot for Solana.

**Site:** [dlmmbot.com](https://dlmmbot.com) · **Docs:** [dlmmbot.com/setup](https://dlmmbot.com/setup/)

Scans hot SOL-quoted meme pools, vets the token, opens a **one-sided SOL** LP below price, then exits by fixed rules. PnL lives in SQLite. **Paper first** — live is double-locked (config + env).

> Memecoin LP can wipe a wallet. Not financial advice. Burner only.

## Setup

| Path | Who it’s for | Link |
|---|---|---|
| **Easy — Railway** | Most users (one service, automated config) | [Docs → Easy](https://dlmmbot.com/setup/easy.html) · [Sign up](https://railway.com?referralCode=SCj9lN) |
| **Advanced — local / VPS / PM2** | You already have a box | [Docs → Advanced](https://dlmmbot.com/setup/advanced.html) |

**Railway (shortest path):** Deploy `CryptoGnome/dlmmbot` → attach volume at `/app/data` → Generate domain → open the URL (token is in deploy logs if unset) → first-run setup wizard (RPC, encrypted wallet create/import, paper/live) or Settings.

`railway.toml` builds the dash and starts farmer + dashboard together. Paper mode is the default. Runtime config/env/db live on the volume under `/app/data` (repo `config.toml` is only a template). Optional: set `WALLET_PASSPHRASE` on Railway to auto-unlock an encrypted wallet on boot.

---

## In this repo

| Doc | What |
|---|---|
| [dlmmbot.com](https://dlmmbot.com) | Marketing site |
| [STRATEGY.md](STRATEGY.md) | Full strategy / exits |
| [config.toml](config.toml) | Live knobs (hot-reloaded) |

---

## Safety (short)

- Paper needs no wallet (`FARMER_MODE=paper`)
- Live needs **both** `[exec].mode = "live"` and `FARMER_MODE=live`
- Prefer the dashboard **encrypted wallet** (create or Phantom import); unlock into `.env` only when trading
- One bot process per wallet/DB

---

## Disclaimer

Provided as-is. You can lose 100% of funds under this bot’s control. Paper first. Burner only.
