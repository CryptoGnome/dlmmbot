# Server deployment

## One-time setup

```bash
git clone https://github.com/CryptoGnome/dlmmbot.git
cd dlmmbot
npm install
cp .env.example .env        # Helius RPC_URL + JUPITER_API_KEY (see docs/setup/advanced)
npm i -g pm2
pm2 start deploy/ecosystem.config.cjs
pm2 save && pm2 startup     # survive reboots (follow the printed instructions)
```

This starts three PM2 apps:

- **meteora-farmer** — the bot (`npm run run`), auto-restarted on crash.
- **meteora-deploy** — the auto-deploy watcher: polls `origin/master` every 30s;
  on new commits it verifies the new SHA in a **detached throwaway worktree**
  (`npm ci` if dependency manifests changed, typecheck, tests, dashboard build)
  and **only moves the live checkout and restarts the bot when everything is
  green** — the working tree never holds an unverified commit. Before the
  restart it waits up to 120s for `data/busy.flag` to clear so a deploy never
  lands mid-executor-transaction. A broken push never takes down the running
  bot — it keeps the last good build and retries when a fixed commit lands.
  GitHub Actions CI also typechecks every push, so a red X on the commit means
  the server won't deploy it.
  Auto-update is on by default (`data/deploy-prefs.json`); turn it off in
  Settings → Wallet & secrets, then Approve from the Changes tab to pull. If
  the gate cannot be evaluated (e.g. corrupt prefs file), the watcher holds
  the deploy rather than assuming approval.
- **meteora-dash** — LAN ops dashboard (`deploy/dashboard-server.mjs`) on port
  **8787**. Read-only against `data/farmer.db`. Requires `DASH_TOKEN` in `.env`.

## LAN dashboard

Build once (or let auto-deploy rebuild when `dashboard/` changes):

```bash
cd dashboard && npm ci && npm run build && cd ..
# ensure DASH_TOKEN is set in .env
pm2 start deploy/ecosystem.config.cjs --only meteora-dash
# or: pm2 restart meteora-dash --update-env
```

Open from any machine on the LAN:

```
http://<server-lan-ip>:8787/?token=YOUR_DASH_TOKEN
```

- Polls live watch every 15s and history every 60s.
- **Do not port-forward 8787 to the WAN** — token is a shared secret, not full auth.
- Dashboard crashes do not restart the farmer (separate PM2 app).

## Log rotation (do this once)

PM2 keeps appending to its log files forever; weeks of tick logs will fill the
disk, and a full disk makes SQLite writes fail mid-position. Install
pm2-logrotate once and cap it:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M      # rotate a log when it reaches 10 MB
pm2 set pm2-logrotate:retain 14         # keep 14 rotated files per app
pm2 set pm2-logrotate:compress true     # gzip rotated logs
```

## Workflow after setup

Push to `master` from anywhere → server picks it up within ~30s and restarts
the bot on the new code. Watch it with:

```bash
pm2 logs meteora-deploy --lines 20
```

```bash
pm2 logs meteora-farmer --lines 50
```

## Not in the repo (transfer manually, once)

- `.env` — API keys. Never commit.
- `data/farmer.db` — copy from the dev machine if you want decision-log /
  Kelly-sample / promotion-day history to carry over; omit for a fresh ledger.
- Wallet keypair file (live mode only) — put it outside the repo directory and
  point `WALLET_KEYPAIR_PATH` at it.

## Important

- **Run the bot on ONE machine at a time.** The single-instance lock is
  per-machine; a dev-PC loop and a server loop would double-trade the same
  strategy (and in live mode, the same wallet). When the server takes over,
  stop the local loop.
- Restarts are safe: positions live in SQLite; paper mode resumes them, live
  mode reconciles against the chain at startup (chain wins).
- Config changes in `config.toml` hot-reload without a restart — but pushing
  them through git triggers a restart via the watcher anyway, which is also fine.

## Liveness monitoring (out-of-process)

Every alert the farmer sends originates inside the farmer, so none of them can
tell you the farmer is gone — "no Telegram messages" reads identically to "quiet
market". `deploy/heartbeat-check.cjs` closes that gap from outside the process.

The manager writes a `meta.heartbeat` row at the end of every tick (ts, pid,
build, mode, open positions, probe failures). The checker reads it read-only and
alerts to the same Telegram chat when it is older than 5 minutes — 20 ticks at
`poll_s = 15`. It alerts on the falling edge and then at most hourly, so a long
outage is a handful of messages rather than one every two minutes.

Install (replace `/path/to/dlmmbot` with your clone's absolute path):

    crontab -e
    */2 * * * * /usr/bin/env node /path/to/dlmmbot/deploy/heartbeat-check.cjs >> /tmp/farmer-heartbeat.log 2>&1

Use the ABSOLUTE script path: cron runs from $HOME, and a relative path silently
fails there — a monitor that never runs is worse than none, because you believe
you have one.

The checker reads Telegram credentials the same way the farmer does:
`FARMER_ENV_PATH` if set, else `data/.env`, merged over the repo `.env` (the
`data/.env` values win) — so wizard/dashboard-configured setups alert without
any extra wiring.

Run it by hand any time with `npm run heartbeat-check`. Exit codes: 0 healthy,
1 stale or missing (alert sent), 2 the checker itself could not read the DB.
Exit-2 failures do not page immediately (a broken checker should not wake you
over one blip), but every 5th consecutive failure sends a "could not check, bot
state unknown" alert — sqlite-won't-load or an unreadable DB means the farmer
is certainly not trading.

It is dependency-free and imports nothing from `src/` on purpose: a monitor that
shares a failure mode with the thing it monitors is not a monitor. Note it runs
on the same box, so it detects a dead process, not a dead machine.

## Recovering a stuck position row

If a position is closed on chain but its DB row is still `open`, the manager
will now throw on every mark rather than mark it worthless, and reconcile will
refuse to orphan it. That is deliberate — see the 2026-08-10 watchdog commit —
but it means the row needs a human:

    npm run force-close -- <id> "why"

It checks the chain first and refuses if any tracked position account still
exists, so it cannot be used to write off a live position. `exit_sol` and
`close_return_sol` are left NULL because the outcome is genuinely unknown; such
a row contributes 0 to realized PnL rather than a fabricated number.

## Site analytics (Umami)

Marketing + setup docs load Umami via `docs/assets/umami.js` (and
`docs-site/docs/public/umami.js`, kept in sync). Team/home/VPS public egress
IPs go in the `BLOCKED` array there so our visits are not tracked. After an ISP
change, add the new address and push — Cloudflare’s `/cdn-cgi/trace` supplies
the visitor IP on dlmmbot.com.

## Site deployment (dlmmbot.com)

Production is **Cloudflare Pages** project `dlmmbot` (custom domains
`dlmmbot.com`, `www.dlmmbot.com`).

**Build settings (Cloudflare dashboard → Pages → dlmmbot → Settings):**

| Setting | Value |
|--------|--------|
| Root directory | *(repo root — leave empty)* |
| Build command | `npm run docs:build` |
| Output directory | `docs` |

Do **not** set root directory to `docs` only. That made Cloudflare skip pushes
whose commits touched `docs-site/` (VitePress source outside that folder) with
**“No deployment available”** / `skip_reason: path_config`. Bot-only commits
still redeployed the old site; site edits were silently skipped.

Every push to `master` should now build VitePress into `docs/setup/` and
publish the whole `docs/` tree (marketing `index.html` + setup docs).

**Manual redeploy:** GitHub Actions → **Deploy site** (needs repo secrets
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`), or Cloudflare Pages →
**Create deployment** on `master`.

**Local check before push:** `npm run docs:build` then spot-check `docs/`.
