---
title: FAQ
description: Honest answers — can you lose money (yes), why paper first, one-sided SOL, restarts, RPC, and the one-instance rule.
---

# FAQ

Straight answers. Where a question touches money, the honest answer comes first.

## Can I lose money?

**Yes.** From the project's own disclaimers, verbatim:

> Memecoin LP can wipe a wallet. Not financial advice. Burner only.

> Provided as-is. You can lose 100% of funds under this bot's control. Paper first. Burner only.

The strategy's expectancy comes from many small fee wins plus **rare full losses** on rugs that beat the safety triggers. The vetting engine cannot catch a well-executed slow rug; sizing caps and brakes bound the damage, they don't eliminate it. The stop loss realizes −25%+ by definition when it fires. Use a dedicated burner wallet and assume its contents can go to zero. See [Risk & sizing](./risk).

## Why paper mode first?

Three reasons:

1. **The pipeline is identical.** Paper runs the full brain — real scanning, real vetting, real pool data — with simulated fills. What you learn transfers.
2. **The promotion gate needs data.** `npm run status` tracks consecutive profitable paper days; eligibility is **7 in a row** (after simulated costs). That scoreboard is how you decide with evidence instead of hope.
3. **Live is double-locked on purpose.** Real trading requires **both** `[exec] mode = "live"` in config **and** `FARMER_MODE=live` in the environment. One switch alone stays safe — no single mis-click starts spending SOL.

## How much SOL do I need?

There is no hard minimum — the sizing floors scale with your wallet, so the bot runs the same strategy at 1 SOL as at 30:

| Wallet | Position floor | Reserve held back | Slots you can actually fill |
|---|---|---|---|
| 1 SOL | 0.05 | 0.35 | 5 |
| 5 SOL | 0.05 | 1.5 | 5 |
| 10 SOL | 0.10 | 2.0 | 5 |
| 30 SOL+ | 0.30 | 1.0 + 10% | 5 |

Smaller wallets take proportionally smaller positions, and they only enter pools whose bin arrays are already initialised — non-refundable rent is capped at 25% of the position, which a fresh pool can't satisfy at small size. Below about **0.5 SOL** the per-trade overhead (a new mint's token account plus fees, ~0.002 SOL) starts eating a real share of each position, so that's the practical bottom rather than a coded limit. See [Risk & sizing](./risk).

## What's the usage fee?

See **[Fees](./fees)** — 1% of live wins buys and burns GNME (CryptoGnome’s mining-game token).

## Why one-sided SOL below price?

Because it's the shape where "nothing happens" costs you almost nothing:

- Price **dips into the range** → the bins buy tokens progressively cheaper; if price recovers back through, the same bins sell them above acquisition price, plus fees both ways. That's the win condition.
- Price **never visits** → your SOL was never converted. No loss — just idle capital and a little rent.
- Price **falls through the bottom** → you hold tokens bought on the way down; the mechanical P5/P1/P0 exits cut it rather than riding to zero.

Compare a two-sided or above-price entry: you'd hold the token from minute one, exposed to the full downside before earning anything. One-sided-below is the capital-preservation-first version of LPing memes. See [How it works](./how-it-works).

## What happens when the bot restarts?

Restarts are safe by design:

- Positions live in SQLite, not memory.
- On startup, the bot enumerates the wallet's actual on-chain DLMM positions and reconciles: **the chain wins**, the DB gets repaired, discrepancies are logged.
- Paper mode simply resumes its simulated positions.
- Amounts are always taken from parsed transaction results, never from what the bot *intended* to do.

Crash-restart loops are handled by PM2/Railway supervision; the out-of-process heartbeat checker tells you if the farmer is actually gone (an in-process alert can't report its own death).

## What are the RPC requirements?

- **Paper:** still use a real RPC — we suggest [Helius](https://www.helius.dev/) (`RPC_URL`). Public mainnet works for a smoke test but chokes under load.
- **Live:** Helius (or another private RPC) is strongly recommended. The manager polls every open position on a 15s cadence plus holder snapshots, claims, and swaps — free public endpoints rate-limit exactly when it matters.
- **Jupiter:** get a free API key at [developers.jup.ag/portal](https://developers.jup.ag/portal) (`JUPITER_API_KEY`). Required for the live swap path and for `npm run simulate-zap` before you trust live mode. Copy the key at creation — Jupiter shows it only once. [Setup guide](https://developers.jup.ag/docs/portal/setup).
- If RPC goes dark, the bot **freezes new entries and alerts** — it never blind-closes positions it can't see. See [Risk & sizing → Watchdog](./risk#watchdog-liveness).

## Why one bot instance per wallet?

Two loops against the same wallet/DB would double-trade the same strategy — same entries, conflicting exits, corrupted accounting. The loop holds `data/farmer.lock`, but the lock is **per-machine**: it cannot stop a dev PC and a server both running. When one host takes over, stop the other.

## The Windows kill gotcha

On Windows, killing a background `npm run run` kills **only the npm wrapper** — the `tsx` child process survives and keeps trading. To actually stop it: kill every node process whose command line matches the repo path, then delete `data/farmer.lock`. (Or avoid the situation: use `npm run pause` / `npm run halt` to stop trading before touching processes.)

## Do I need the GMGN API key?

No — the core pipeline runs without it. With a key you get trending/smart-money score bonuses (capped at +10) and extra honeypot/sell-tax vetting.

**How to get one (free):** [API keys → GMGN](./api-keys#gmgn-api-key-gmgn_api_key-optional) — generate an Ed25519 public key, upload at [gmgn.ai/ai](https://gmgn.ai/ai), paste the API key as `GMGN_API_KEY`. You do **not** need `GMGN_PRIVATE_KEY` for this bot.

## Can the bot trade SOL-USDC or other stable pairs?

No, and it's not planned — stable pairs are **permanently out of scope**, a decided non-feature. The strategy is SOL-quoted only: the accumulate-SOL thesis, with PnL measured in SOL.

## Where do my settings actually live?

Under `data/` on your host or Railway volume (`data/config.toml`, `data/.env`, `data/farmer.db`). The repo's `config.toml` is only a first-run template. Config changes **hot-reload** — no restart needed. See [Configuration reference](./configuration).

## Is this custody? Who holds my keys?

You do. The encrypted wallet (`wallet.enc.json`) lives on **your** volume/host, encrypted with **your** passphrase. Nothing is sent to the project's servers. It is not a hosted trading service.

## Is this open source? Can I copy it?

The code is public to **run, study, and modify for your own bot**. The license is **[PolyForm Shield 1.0.0](https://github.com/CryptoGnome/dlmmbot/blob/main/LICENSE)** — you cannot ship a competing product or hosted copy. Full terms are in the repo `LICENSE`.

## Who is liable if I lose money?

**You are.** DLMM Bot is free software provided as-is. The [Terms of Service & Risk Waiver](./terms) (and PolyForm’s No Liability clause) say we are not responsible for trading losses, bugs, or third-party failures. The setup wizard requires acceptance before you continue.

<p class="cta-row">
  <a class="doc-btn" href="./easy">Easy setup</a>
  <a class="doc-btn ghost" href="./terms">Terms & waiver</a>
  <a class="doc-btn ghost" href="./risk">Risk & sizing</a>
  <a class="doc-btn ghost" href="./how-it-works">How it works</a>
</p>
