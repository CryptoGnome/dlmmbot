# DLMM Bot

Automated **Meteora DLMM** liquidity bot for Solana.

**Site:** [dlmmbot.com](https://dlmmbot.com) · **Docs:** [dlmmbot.com/setup](https://dlmmbot.com/setup/)

Scans hot SOL-quoted meme pools, vets the token, opens a **one-sided SOL** LP below price, then exits by fixed rules. PnL lives in SQLite. **Paper first** — live is double-locked (config + env).

> Memecoin LP can wipe a wallet. Not financial advice. Burner only.

## Setup

| Path | Who it’s for | Link |
|---|---|---|
| **Easy — Railway** | Most users | [Docs → Easy](https://dlmmbot.com/setup/easy.html) · [Sign up](https://railway.com?referralCode=SCj9lN) |
| **Advanced — local / VPS / PM2** | You already have a box | [Docs → Advanced](https://dlmmbot.com/setup/advanced.html) |

Local preview of the site: open [`docs/index.html`](docs/index.html) in a browser.

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
- Wallet keys are only read by the live executor
- One farmer process per wallet/DB

---

## Disclaimer

Provided as-is. You can lose 100% of funds under this bot’s control. Paper first. Burner only.
