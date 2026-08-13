# meteora-farmer

Automated **Meteora DLMM** liquidity bot for Solana.

Scans hot SOL-quoted meme pools, vets the token, opens a **one-sided SOL** LP below price, then exits by fixed rules. PnL lives in SQLite. **Paper first** — live is double-locked (config + env).

> Memecoin LP can wipe a wallet. Not financial advice. Burner only.

## Setup guide (recommended)

The full, easy-to-follow install walkthrough is hosted as a web page:

**[Open the Setup Guide →](https://cryptognome.github.io/meteora-farmer/)**

(Private key export, RPC, Jupiter, paper → live — all there.)

If Pages isn’t live yet: repo **Settings → Pages → Source: GitHub Actions**, then re-run the **Deploy docs** workflow (or push any change under `docs/`).

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
