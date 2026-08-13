# DLMM Bot

Automated **Meteora DLMM** liquidity bot for Solana (`dlmmbot.com`).

Scans hot SOL-quoted meme pools, vets the token, opens a **one-sided SOL** LP below price, then exits by fixed rules. PnL lives in SQLite. **Paper first** — live is double-locked (config + env).

> Memecoin LP can wipe a wallet. Not financial advice. Burner only.

## Setup (pick one)

| Path | Who it’s for | Guide |
|---|---|---|
| **Easy — Railway** | Most users (no VPS, public dash URL, auto-redeploy) | [`docs/index.html`](docs/index.html) · [Sign up](https://railway.com?referralCode=SCj9lN) |
| **Advanced — local / VPS / PM2** | You already have a server or want full control | [`docs/advanced.html`](docs/advanced.html) |

Open the HTML files in a browser (or host `docs/` on Pages / Cloudflare when the repo is public).

**Recommended default for newcomers:** [Railway](https://railway.com?referralCode=SCj9lN) — see the easy guide. Operators with a box (PM2, auto-deploy) use Advanced.

---

## Docs in this repo

| Doc | What |
|---|---|
| [docs/index.html](docs/index.html) | Easy setup (Railway) |
| [docs/advanced.html](docs/advanced.html) | Local, VPS, PM2, tunnels |
| [STRATEGY.md](STRATEGY.md) | Full strategy / exits |
| [config.toml](config.toml) | Live knobs (hot-reloaded) |

---

## Safety (short)

- Paper needs no wallet (`FARMER_MODE=paper`)
- Live needs **both** `[exec].mode = "live"` and `FARMER_MODE=live`
- Wallet keys are only read by the live executor
- One farmer process per wallet/DB

---

## Disclaimer

Provided as-is. You can lose 100% of funds under this bot’s control. Paper first. Burner only.
