# meteora-farmer

Automated **Meteora DLMM** liquidity bot for Solana.

Scans hot SOL-quoted meme pools, vets the token, opens a **one-sided SOL** LP below price, then exits by fixed rules. PnL lives in SQLite. **Paper first** — live is double-locked (config + env).

> Memecoin LP can wipe a wallet. Not financial advice. Burner only.

## Setup guide (recommended)

A proper HTML setup walkthrough lives in [`docs/`](docs/) (step cards, sticky TOC, copy buttons).

**View it**

1. **Locally (works now):** open [`docs/index.html`](docs/index.html) in your browser  
   (or from the repo root: `start docs/index.html` on Windows / `open docs/index.html` on Mac).
2. **GitHub Pages** (nice public URL): this repo is **private**, and free GitHub plans only offer Pages on **public** repos. Either:
   - make the repo public, then **Settings → Pages → Source: GitHub Actions**, or  
   - keep it private and use a free host (Cloudflare Pages / Netlify / Vercel) pointed at the `docs/` folder.

Once Pages is on, the URL will be:

`https://cryptognome.github.io/meteora-farmer/`

The **Deploy docs** workflow (`.github/workflows/pages.yml`) is already in the repo.

---

## Quickstart (paper)

```bash
git clone https://github.com/CryptoGnome/meteora-farmer.git
cd meteora-farmer
npm install
cp .env.example .env
```

In `.env`:

```env
FARMER_MODE=paper
RPC_URL=https://api.mainnet-beta.solana.com
```

In `config.toml` under `[exec]`:

```toml
mode = "paper"
```

```bash
npm run run      # start
npm run status   # other terminal
npm run halt     # stop
```

---

## Docs in this repo

| Doc | What |
|---|---|
| **[Setup Guide (HTML)](https://cryptognome.github.io/meteora-farmer/)** | Step-by-step install |
| [STRATEGY.md](STRATEGY.md) | Full strategy / exits |
| [config.toml](config.toml) | Live knobs (hot-reloaded) |
| [docs/](docs/) | Source for the Pages site |

---

## Commands

```bash
npm run scan | vet | run | status | halt | force-close | test
npm run dash:build && npm run dash   # optional LAN UI :8787
```

---

## Safety (short)

- Paper needs no wallet
- Live needs **both** `[exec].mode = "live"` and `FARMER_MODE=live`
- Wallet keys are only read by the live executor
- One farmer process per wallet/DB

---

## Disclaimer

Provided as-is. You can lose 100% of funds under this bot’s control. Paper first. Burner only.
