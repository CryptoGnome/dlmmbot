# DLMM Bot

Automated **Meteora DLMM** liquidity bot for Solana.

**Site:** [dlmmbot.com](https://dlmmbot.com) · **Docs:** [dlmmbot.com/setup](https://dlmmbot.com/setup/)

Setup docs are **VitePress** (`docs-site/`). Edit markdown there, then `npm run docs:build` (writes into `docs/setup/`). Marketing homepage stays `docs/index.html`.

Scans hot SOL-quoted meme pools, vets the token, opens a **one-sided SOL** LP below price, then exits by fixed rules. PnL lives in SQLite. **Paper first** — live is double-locked (config + env).

> Memecoin LP can wipe a wallet. Not financial advice. Burner only.
>
> **Usage fee:** see [docs → Fees](https://dlmmbot.com/setup/fees).

## Setup

| Path | Who it’s for | Link |
|---|---|---|
| **Easy — Railway** | Most users (one service, automated config) | [Docs → Easy](https://dlmmbot.com/setup/easy) · [Sign up](https://railway.com?referralCode=SCj9lN) |
| **Advanced — local / VPS / PM2** | You already have a box | [Docs → Advanced](https://dlmmbot.com/setup/advanced) · [Vultr VPS](https://www.vultr.com/?ref=9917878-9J) |

**Railway (shortest path):** Deploy `CryptoGnome/dlmmbot` → attach volume at `/app/data` → Generate domain → open the URL (token is in deploy logs if unset) → first-run setup wizard (Helius RPC, Jupiter API key, encrypted wallet, paper/live) or Settings.

`railway.toml` builds the dash and starts farmer + dashboard together. Paper mode is the default. Runtime config/env/db live on the volume under `/app/data` (repo `config.toml` is only a template). Optional: set `WALLET_PASSPHRASE` on Railway to auto-unlock an encrypted wallet on boot.

---

## In this repo

| Doc | What |
|---|---|
| [dlmmbot.com](https://dlmmbot.com) | Marketing site |
| [dlmmbot.com/setup](https://dlmmbot.com/setup/) | Full docs — setup, [how it works](https://dlmmbot.com/setup/how-it-works), [strategy](https://dlmmbot.com/setup/strategy), [risk](https://dlmmbot.com/setup/risk), [config](https://dlmmbot.com/setup/configuration), [dashboard](https://dlmmbot.com/setup/dashboard), [CLI](https://dlmmbot.com/setup/cli), [FAQ](https://dlmmbot.com/setup/faq) |
| [STRATEGY.md](STRATEGY.md) | Full strategy / exits |
| [DEPLOY.md](DEPLOY.md) | Server / PM2 / Railway |
| [RELEASE.md](RELEASE.md) | **develop → main** branching + semver releases |
| [config.toml](config.toml) | Live knobs (hot-reloaded) |
| [profiles/](profiles/) | Official + community settings packs ([docs](https://dlmmbot.com/setup/profiles)) |

---

## Safety (short)

- Paper needs no wallet (`FARMER_MODE=paper`)
- Live needs **both** `[exec].mode = "live"` and `FARMER_MODE=live`
- Prefer the dashboard **encrypted wallet** (create or Phantom import); unlock into `.env` only when trading
- One bot process per wallet/DB

---

## Disclaimer

Provided as-is. You can lose 100% of funds under this bot’s control. Paper first. Burner only.
