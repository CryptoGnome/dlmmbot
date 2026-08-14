---
title: FAQ
description: Honest answers — can you lose money (yes), why paper first, the 1% GNME burn fee, one-sided SOL, restarts, RPC, and the one-instance rule.
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

## What's the 1% GNME burn fee?

The product's usage fee: on each **live winning close**, 1% of the *measured* net profit (wallet open cost → close return + fees + rent) buys and burns [GNME](https://solscan.io/token/BaDjVCpABEVCdt4LT7ivuzA4izBwJCqnDjrLa8XBtT38) via Jupiter in one transaction.

- Charged only on **wins** — losses and mark-only closes pay nothing.
- **Paper mode logs it without spending.**
- It is **hardcoded** (`src/executor/profitBurn.ts`), deliberately not a Settings knob, and profiles can't change it.
- If the burn swap fails, the amount sits in a pot and is retried — it isn't silently dropped or double-charged.

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

- **Paper:** the public `https://api.mainnet-beta.solana.com` endpoint works — no wallet needed at all.
- **Live:** use a **private RPC** (`RPC_URL`). The manager polls every open position on a 15s cadence plus holder snapshots, claims, and swaps — free public endpoints rate-limit exactly when it matters. A Jupiter API key (`JUPITER_API_KEY`) is needed for the swap path.
- If RPC goes dark, the bot **freezes new entries and alerts** — it never blind-closes positions it can't see. See [Risk & sizing → Watchdog](./risk#watchdog--liveness).

## Why one bot instance per wallet?

Two loops against the same wallet/DB would double-trade the same strategy — same entries, conflicting exits, corrupted accounting. The loop holds `data/farmer.lock`, but the lock is **per-machine**: it cannot stop a dev PC and a server both running. When one host takes over, stop the other.

## The Windows kill gotcha

On Windows, killing a background `npm run run` kills **only the npm wrapper** — the `tsx` child process survives and keeps trading. To actually stop it: kill every node process whose command line matches the repo path, then delete `data/farmer.lock`. (Or avoid the situation: use `npm run pause` / `npm run halt` to stop trading before touching processes.)

## Do I need the GMGN API key?

No. GMGN trending/smart-money feeds are **discovery enrichment** — score bonuses capped at +10, plus extra security flags. With no `GMGN_API_KEY` the feature auto-disables and the core pipeline (Meteora datapi + RPC + RugCheck) runs unchanged.

## Can the bot trade SOL-USDC or other stable pairs?

No, and it's not planned — stable pairs are **permanently out of scope**, a decided non-feature. The strategy is SOL-quoted only: the accumulate-SOL thesis, with PnL measured in SOL.

## Where do my settings actually live?

Under `data/` on your host or Railway volume (`data/config.toml`, `data/.env`, `data/farmer.db`). The repo's `config.toml` is only a first-run template. Config changes **hot-reload** — no restart needed. See [Configuration reference](./configuration).

## Is this custody? Who holds my keys?

You do. The encrypted wallet (`wallet.enc.json`) lives on **your** volume/host, encrypted with **your** passphrase. Nothing is sent to the project's servers. It is not a hosted trading service.

## Related

- [Risk & sizing](./risk) — the full safety model
- [How it works](./how-it-works) — the pipeline in plain language
- [Strategy reference](./strategy) — every exit rule
- [Easy setup (Railway)](./easy) · [Advanced setup](./advanced)
- [CLI reference](./cli) — status, halt, pause, force-close
