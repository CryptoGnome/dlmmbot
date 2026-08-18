import type { WikiSection } from "./types";

/**
 * In-dashboard operator wiki. Keep in sync with STRATEGY.md / config.toml /
 * farmer loop when behavior changes (see .cursor/rules/wiki-sync-on-commit.mdc).
 * Write for a brand-new operator first; details second. Live knobs = Settings / config.toml.
 */
export const WIKI_SECTIONS: WikiSection[] = [
  {
    id: "overview",
    title: "Big picture",
    icon: "bot",
    simple: "We put SOL under a token’s price, earn fees when it wiggles, then cash back to SOL by fixed rules.",
    summary: "What DLMM Bot does in one glance — no jargon required.",
    blocks: [
      {
        type: "tldr",
        text: "Think of it like a market stall under the current price: shoppers (traders) walk through our bins, we collect a tiny fee each time, and we leave when the rules say leave — not when we “feel” like it.",
      },
      {
        type: "flow",
        title: "The loop (every few minutes)",
        steps: [
          { label: "Find pools", detail: "Hot SOL pairs on Meteora", icon: "radar" },
          { label: "Safety check", detail: "Skip rugs & traps", icon: "shield" },
          { label: "Place SOL", detail: "Liquidity below price", icon: "coins" },
          { label: "Earn fees", detail: "While price trades our range", icon: "chart" },
          { label: "Exit by rules", detail: "P0→P5 priority list", icon: "exit" },
          { label: "Bank SOL", detail: "Fees + PnL in the wallet", icon: "bank" },
        ],
      },
      {
        type: "cards",
        items: [
          {
            title: "Unit of account = SOL",
            text: "Wins and losses are measured in SOL, not vibes or USD screenshots.",
            icon: "coins",
          },
          {
            title: "Rules beat gut feel",
            text: "No whale chat. When humans would argue, the bot takes the safer exit.",
            icon: "shield",
          },
          {
            title: "Paper before live",
            text: "Default is paper (practice). Live needs two explicit switches — easy to stay safe.",
            icon: "lock",
            tone: "warn",
          },
          {
            title: "Burner wallet only",
            text: "Never your main bag. Assume memecoin LP can go to zero.",
            icon: "alert",
            tone: "danger",
          },
        ],
      },
      {
        type: "callout",
        tone: "fg",
        title: "Where the deep spec lives",
        text: "This Wiki is the friendly tour. STRATEGY.md in the repo is the full rulebook. Settings / config.toml is what the running bot actually obeys.",
      },
    ],
  },
  {
    id: "architecture",
    title: "The moving parts",
    icon: "boxes",
    simple: "Three processes + a database: the farmer trades, the dash shows you, the deployer updates code.",
    summary: "What’s running on your host and who does what.",
    blocks: [
      {
        type: "tldr",
        text: "You don’t babysit every trade. You watch the dashboard; the farmer process does the work; updates can pull from GitHub when you allow them.",
      },
      {
        type: "cards",
        items: [
          {
            title: "Farmer",
            badge: "brain",
            text: "Scans, vets, opens, manages, closes. This is the strategy.",
            icon: "bot",
          },
          {
            title: "Dashboard",
            badge: "eyes",
            text: "The UI you’re in now — live book, charts, halt, settings, this Wiki.",
            icon: "layout",
          },
          {
            title: "Deploy watcher",
            badge: "updates",
            text: "Pulls new builds from GitHub (auto or Approve on Changes).",
            icon: "refresh",
          },
          {
            title: "SQLite + config",
            badge: "memory",
            text: "Positions, decisions, errors, token icons — plus your knobs in data/config.toml.",
            icon: "calc",
          },
        ],
      },
      {
        type: "h3",
        text: "Paper vs live (easy version)",
      },
      {
        type: "steps",
        items: [
          {
            title: "Paper",
            text: "Full brain, fake fills. Great for learning and testing gates.",
            icon: "play",
          },
          {
            title: "Live",
            text: "Real SOL. Needs FARMER_MODE=live AND Settings/exec mode = live — both must agree.",
            icon: "zap",
          },
        ],
      },
    ],
  },
  {
    id: "sleeves",
    title: "Three playbooks",
    icon: "layers",
    simple: "Same bot, three play styles: tiny memes, main memes, and slower majors.",
    summary: "micro · meme · majors — stamped when we enter.",
    blocks: [
      {
        type: "tldr",
        text: "A “sleeve” is which playbook we used for that position. It decides range shape and how aggressive sizing can be.",
      },
      {
        type: "cards",
        items: [
          {
            title: "Micro",
            badge: "small / careful",
            text: "Very young / small mcap memes. Tiny size, BidAsk under price, tight caps — loss budget first.",
            icon: "shield",
          },
          {
            title: "Meme",
            badge: "main book",
            text: "The bread-and-butter. BidAsk under price, Kelly or Fixed sizing, escape hatch + profit lock.",
            icon: "chart",
          },
          {
            title: "Majors",
            badge: "alts",
            text: "Allowlisted SOL-quoted alts. Spot (flat) bins + separate timing. P2 rotation needs BOTH fee and volume dead (and a lower fee floor than entry) so parks like PUMP don’t churn every few minutes. Settings → Majors parking: search a ticker on Meteora and add to the allowlist. Runs after memes so hot memes keep slots. Since v0.14.0 majors also respect the 24h re-entry cooldown after our own stop / below-range / safety exit — but not meme vetting bans.",
            icon: "layers",
          },
        ],
      },
      {
        type: "callout",
        tone: "warn",
        title: "After a loss, we sit out 24h — in every sleeve",
        text: "When we cut a token on a stop, a below-range exit or a safety exit, that token is benched for 24h so the bot can’t immediately buy back the thing it just decided was broken. Until v0.14.0 the majors sleeve never checked — on 18 Aug it cut ANSEM for −0.079 SOL and re-entered the same token five seconds later, on both live bots. Vetting bans (holder concentration, insider clusters, RugCheck) are meme rules and still don’t apply to allowlisted majors.",
      },
      {
        type: "callout",
        tone: "fg",
        title: "Out of scope forever",
        text: "Stable pairs like SOL-USDC are not a “later” feature — they’re off the menu.",
      },
    ],
  },
  {
    id: "scanning",
    title: "Finding & filtering",
    icon: "scan",
    simple: "We only look at busy SOL pools, then throw out anything that smells like a rug.",
    summary: "How a token gets on the shortlist — and how most get rejected.",
    blocks: [
      {
        type: "flow",
        title: "Candidate pipeline",
        steps: [
          { label: "Sweep pools", detail: "Meteora DLMM list", icon: "radar" },
          { label: "Dedupe", detail: "One mint wins per ticker", icon: "check" },
          { label: "Pool gates", detail: "TVL, fees, volume…", icon: "chart" },
          { label: "Pick the pool", detail: "Deepest gate-passing pool per token — not the highest fee/TVL, which picks the thinnest one", icon: "chart" },
          { label: "Token vet", detail: "Authorities, holders, rugs", icon: "shield" },
          { label: "Score", detail: "0–100 opportunity", icon: "zap" },
          { label: "Queue", detail: "Best first", icon: "entry" },
        ],
      },
      {
        type: "h3",
        text: "Hard “no” examples (pool)",
      },
      {
        type: "ul",
        items: [
          "Too thin or too huge TVL, sleepy fees/volume, weird base fee, non-SOL quote.",
          "Pool price way off Jupiter (empty / glitchy pool trap).",
        ],
      },
      {
        type: "h3",
        text: "Hard “no” examples (token)",
      },
      {
        type: "ul",
        items: [
          "Mint/freeze still on, nasty Token-2022 hooks, whale-concentrated supply.",
          "Creator already rugged once → permanent ban.",
          "RugCheck “Danger” is a veto only — never a green light by itself.",
          "Brand-new tokens wait out the instant-rug window (45 min) — that one is a safety gate. There is no upper age limit by default: a revived old meme with real volume is a valid pool, and the fee/volume gates already prove it's alive. Flip on \"Too old\" in Settings to cap mint age again.",
        ],
      },
      {
        type: "callout",
        tone: "fg",
        title: "Soft stuff only tilts size",
        text: "Freefall, ATH blast, sell pressure — these change the score (how big / how soon), they don’t secretly override a hard fail.",
      },
      {
        type: "callout",
        tone: "warn",
        title: "GMGN is paced",
        text: "Optional trending / honeypot / holder checks share one serial queue with **separate leaky buckets per module** (market, token, track). Local pacing mirrors GMGN’s published limits but cannot see the server’s remaining tokens — another bot on the same key (or a drained bucket after restart) can still 429. Holders/traders cost 5×; trader tags off by default. A real `RATE_LIMIT_*` **parks all GMGN until reset** — queued work is dropped (retries extend the ban). Meteora scanning continues.",
      },
    ],
  },
  {
    id: "entry",
    title: "Opening a position",
    icon: "entry",
    simple: "We park SOL in bins under the current price so dips buy tokens and bounces sell them back for fees.",
    summary: "BidAsk shape, rent budgets, and how we open without getting wrecked on slip.",
    blocks: [
      {
        type: "tldr",
        text: "Default meme shape = one-sided SOL below price (BidAsk). We’re not guessing the top — we’re waiting for price to visit us.",
      },
      {
        type: "steps",
        items: [
          {
            title: "Draw the range",
            text: "Top near the current bin; bottom deep enough to matter but not so deep we overpay rent.",
            icon: "chart",
          },
          {
            title: "Respect rent",
            text: "Bin arrays cost SOL. Soft budget first; never more than two arrays.",
            icon: "coins",
          },
          {
            title: "Open BidAsk",
            text: "SOL side only. If the chain rejects on bin slip, rebuild — don’t spam the same bad tx.",
            icon: "entry",
          },
          {
            title: "Exit path ready",
            text: "When we leave, Jupiter turns the token side back into SOL.",
            icon: "bank",
          },
        ],
      },
      {
        type: "p",
        text: "Very high scores may add a second, deeper “tranche” pocket. Tranches count toward your max open slots.",
      },
      {
        type: "callout",
        tone: "fg",
        title: "What we pay to get a transaction landed",
        text: "A Solana priority fee is price × the compute budget the transaction ASKS for — you pay for what you reserve, not what you use. So we set both: the price is the 75th percentile of recent nonzero fees on the specific accounts our transaction writes (a network-wide average under-prices a busy pool, and a busy pool is the only kind we trade), and the compute budget comes from simulating the transaction and adding 20%. Each retry multiplies the fee by 1.5 — re-sending the same fee is the one thing that cannot fix a transaction that failed to land. Raise Settings → Priority fees → Fee cap on a congested day.",
      },
    ],
  },
  {
    id: "exits",
    title: "How we get out",
    icon: "priority",
    simple: "Every few seconds we check rules from most urgent to least. First match wins — always.",
    summary: "The P0→P5 priority ladder. Read top to bottom.",
    blocks: [
      {
        type: "tldr",
        text: "Imagine a fire-escape checklist pinned above the desk. We always start at the top. If P0 says “run,” we don’t argue about profit locks.",
      },
      {
        type: "ladder",
        title: "Priority ladder (top = first)",
        items: [
          {
            code: "P0",
            title: "Safety — leave NOW",
            when: "Rug vibes: TVL collapse, dumps, metadata flip, violent crash…",
            then: "Close and dump token→SOL fast. Rug evidence (dead pool, -60% crash, RugCheck flip, holder dumps) bans the mint + creator for good; a TVL drain only cools the token off for 6h — liquidity leaving a pool looks the same whether it is being traded through or actually rugging, so it does not earn a life sentence",
            tone: "danger",
          },
          {
            code: "P1",
            title: "Stop loss",
            when: "Position value in SOL fell too far vs entry",
            then: "Close, take the loss, cool the token ~24h. Below range it must hold for ~60s first so a wick doesn't cut you (a real crash is caught instantly by P0 anyway); in range it's immediate",
            tone: "danger",
          },
          {
            code: "P2",
            title: "Opportunity died",
            when: "Fees/volume went cold, or the position is too old for meme mode",
            then: "Close and free the slot for better work",
            tone: "warn",
          },
          {
            code: "P3",
            title: "Price above our range",
            when: "Price stayed above the top (win if it visited us; missed if it never did)",
            then: "Close and swap to SOL; wins exit faster than misses (misses wait longer so we don’t churn rent)",
            tone: "fg",
          },
          {
            code: "P4",
            title: "Still in range — manage",
            when: "Price is trading our bins",
            then: "Claim/bank fees; maybe profit-lock a slice; escape hatch closes after deep dip + recovery",
            tone: "fg",
          },
          {
            code: "P5",
            title: "Price below range",
            when: "We’re 100% token after a short wick grace",
            then: "Close, swap all token→SOL, cool the token",
            tone: "warn",
          },
        ],
      },
      {
        type: "cards",
        items: [
          {
            title: "P3 win",
            text: "Price dipped into us, then climbed out. We earned the round trip + fees.",
            tone: "ok",
            icon: "check",
          },
          {
            title: "P3 missed",
            text: "Price blasted off without ever trading our bins. Capital was idle — leave slowly.",
            tone: "warn",
            icon: "x",
          },
        ],
      },
    ],
  },
  {
    id: "follow",
    title: "Follow mode",
    icon: "follow",
    simple: "After a clean up-and-out, we may re-enter the same token — but only on a retrace with hot volume.",
    summary: "Up-only chains. Designed not to chase vertical pumps.",
    blocks: [
      {
        type: "tldr",
        text: "Follow is optional overtime after a P3 close. It is picky on purpose: hot volume + pullback + new highs only. Unguarded chasing lost money in sims.",
      },
      {
        type: "flow",
        title: "A follow chain",
        steps: [
          { label: "P3 close", detail: "Arms the chain — only if the pool is still hot", icon: "exit" },
          { label: "Wait", detail: "Volume + retrace", icon: "pause" },
          { label: "Leg open", detail: "Tighter BidAsk", icon: "entry" },
          { label: "Up-and-out", detail: "Need a new high to re-arm", icon: "chart" },
          { label: "End", detail: "Cold vol / no dip in 90m / loss / max legs", icon: "x", tone: "danger" },
        ],
      },
      {
        type: "ul",
        items: [
          "While a follow chain owns a mint, the normal scanner won’t double-book it — which is why chains that will never fire now end early: a chain only arms if the pool still has real volume at close, and one that waits 90 minutes without its pullback lets the token go. Every leg that ever fired did so within about 50 minutes.",
          "Don’t casually loosen volume/retrace gates — they are the edge.",
        ],
      },
    ],
  },
  {
    id: "sizing",
    title: "How big & how many",
    icon: "scale",
    simple: "We never all-in. Choose Kelly (learns from your book) or Fixed (exact SOL / % per sleeve).",
    summary: "Kelly or Fixed sizing, slots, circuit breaker, cluster brake, regime, HALT.",
    blocks: [
      {
        type: "tldr",
        text: "Wallet stays partly in reserve. Each new position is a measured bite — Kelly from your ledger, or Fixed amounts you set per sleeve. If the book is bleeding, new entries pause — open ones still get managed.",
      },
      {
        type: "flow",
        title: "Sizing mode (Settings → Book & size)",
        steps: [
          { label: "Kelly (default)", detail: "Cold start → estimate f* from closes → kelly_fraction × f* → score tilt → caps." },
          { label: "Fixed", detail: "Each sleeve (core, micro, majors, follow) uses exact SOL or % of deployable. No Kelly, no score size tilt." },
          { label: "Shared clamps", detail: "Min position, max % of wallet, deployable, brakes, and slots still apply." },
        ],
      },
      {
        type: "flow",
        title: "Kelly sizing (Settings → Kelly sizing)",
        steps: [
          { label: "Cold start", detail: "Until min samples, each position uses cold-start % of wallet." },
          { label: "Estimate f*", detail: "Rolling closed trades → win rate + avg win/loss → full Kelly fraction." },
          { label: "Apply fraction", detail: "Bet kelly_fraction × f*, capped at max share of wallet." },
          { label: "Per-sleeve tweak", detail: "Settings → Kelly per-sleeve: Kelly (adaptive × mult), fixed SOL, or % deployable per core/micro/majors/follow." },
          { label: "Score tilt", detail: "Scan score picks low/mid/high multiplier on the result." },
          { label: "Floors", detail: "Never below the min position size; negative edge can block or clamp to the floor." },
        ],
      },
      {
        type: "callout",
        tone: "fg",
        title: "The minimum size scales with your wallet",
        text: "The floor is max(0.05 SOL, min(Minimum size, 1% of equity)) — 0.05 on a 1 SOL wallet, 0.10 at 10 SOL, 0.30 once past 30 SOL. A flat floor is used in four places at once (the Kelly base, the entry cutoff, the override on the 10%-of-wallet cap, and the slot divisor), so a small wallet used to either never enter — the flat reserve ate the whole bankroll — or enter at 15% of equity with the risk cap bypassed, and no bankroll under 20 SOL could take a 60-70 score. Small positions are protected instead by capping bin rent at 25% of the position, so they only enter pools whose bin arrays are already paid for. Set Minimum size (% of wallet) to 0 for a flat floor.",
      },
      {
        type: "cards",
        items: [
          {
            title: "Kelly (with caps)",
            text: "Learns from your closed trades, then clamps with min size, max % of wallet, and score tilt. Knobs under Settings → Kelly sizing.",
            icon: "scale",
          },
          {
            title: "Fixed per sleeve",
            text: "Set core / micro / majors / follow to SOL or % of deployable. Below min size skips the entry — no silent bump.",
            icon: "layers",
          },
          {
            title: "Slot limits",
            text: "Max open positions (tranches count). Small wallets simply run fewer seats.",
            icon: "layers",
          },
          {
            title: "Circuit + cluster",
            text: "Bad day % or a cluster of hard stops → pause new entries for a cool-down (measured from the newest hard exit). Applies to follow-mode legs too. Both read settled PnL, so an exit swap that under-fills won't trip them while the sweep is still selling the leftovers.",
            icon: "pause",
            tone: "warn",
          },
          {
            title: "Close one position",
            text: "Red Close button on each position card, for when you want out of one trade without stopping the bot. Confirm dialog naming the position, its size and unrealised PnL — it sells on chain and can't be undone. The click only queues it — the farmer does the actual close on its next tick (~15s) and reports the PnL like any other exit, booked as \"manual\" so it doesn't skew the strategy's exit stats. The card shows \"Closing…\" until it lands.",
            icon: "alert",
            tone: "warn",
          },
          {
            title: "HALT",
            text: "Big red stop: close everything, idle until Resume. If a close fails (RPC trouble), the rest still close and the failed one retries every few seconds until the book is empty — you get a Telegram note while it's stuck.",
            icon: "alert",
            tone: "danger",
          },
          {
            title: "Usage fee (GNME)",
            text: "1% of measured profit on live winning closes → buy+burn GNME. Hardcoded — not in Settings. Full write-up: dlmmbot.com/setup/fees",
            icon: "zap",
          },
        ],
      },
      {
        type: "p",
        text: "SOL market crashes can shrink or pause new meme size (regime filter). Alpha slots keep room for exceptional scores.",
      },
    ],
  },
  {
    id: "skips",
    title: "What we never touch",
    icon: "ban",
    simple: "A long skip list protects the bankroll — most “opportunities” are politely ignored.",
    summary: "Blacklist vs structural skips.",
    blocks: [
      {
        type: "cards",
        items: [
          {
            title: "Permanent ban",
            text: "Rugged creators, P0 tokens, nasty token extensions.",
            tone: "danger",
            icon: "ban",
          },
          {
            title: "Cooling off (~24h)",
            text: "Copycat tickers we didn’t pick, vet fails, loss exits.",
            tone: "warn",
            icon: "pause",
          },
          {
            title: "Never candidates",
            text: "Arb-fee pools, non-SOL quotes, “we’d be the whole pool” TVL cases.",
            icon: "x",
          },
        ],
      },
      {
        type: "p",
        text: "Every skip reason is logged. Activity / Analytics exist so you can see why we said no — and tune with evidence later.",
      },
    ],
  },
  {
    id: "dashboard",
    title: "This screen",
    icon: "layout",
    simple: "Left rail = rooms in the house. Header = health lights. Wiki = the manual you’re reading.",
    summary: "What each tab is for — in plain English.",
    blocks: [
      {
        type: "tldr",
        text: "You don’t need every tab every day. Overview for “am I ok?”, Positions for open trades, Activity when something weird happens, Wiki when you forget a rule.",
      },
      {
        type: "cards",
        items: [
          { title: "Overview", text: "Money snapshot, open profit with slot occupancy (e.g. 3 of 5 · 2 free), equity chart. Engine ON/OFF + HALT live in the header. Rent in flight = what open positions paid above their deposit (bin rent + open gas, ~0.06–0.12 SOL each). It IS part of Total balance — it's your SOL, and measured across clean closes ~97% comes back. Open profit marks the liquidity only and does not include it — the balance line is where it is reported: wallet + open + rent = Total balance. Without counting it the balance would drop when a position opens and jump when it closes, which tells you nothing about what you're worth.", icon: "chart" },
          { title: "Positions", text: "Open positions (slot badge) + recent closes. Range bar: purple ≈ SOL still waiting, blue ≈ already converted to token as price walks the bins.", icon: "book" },
          { title: "Analytics", text: "Why we made/lost SOL — exits, sleeves, skips.", icon: "calc" },
          { title: "Activity", text: "Play-by-play for the current PAPER/LIVE book only. Entries, exits, claims and open failures from the last 7 days — they never get pushed out by skips. Skips are the last 24h, newest per token+gate, capped so they stay context rather than noise. SOL: green in / win, blue deployed (entries), red only for losses. On-chain rows link to Solscan. The Book tab is the full history.", icon: "zap" },
          { title: "Smart flow", text: "GMGN smart-money + KOL tape in the rolling window (~2 min polls). Same signal that adds score bonuses — live via the watch feed.", icon: "chart" },
          { title: "Errors", text: "Broken stuff with copy/paste for bug reports. Dismiss hides; Clear log deletes rows from the DB. Each row has a plain label (Transient / Degraded / Needs attention).", icon: "alert", tone: "danger" },
          { title: "Report", text: "Bug or enhancement — guided GitHub issue with type/area chips, optional screenshots (paste in GitHub), and auto build context.", icon: "alert" },
          { title: "Research", text: "People we studied — not trade signals.", icon: "book" },
          { title: "Wiki", text: "This guided tour.", icon: "bot" },
          { title: "Changes", text: "GitHub Releases (tag + notes) — pending newer releases when the host is behind. Commit spam is hidden; Approve still works when auto-update is off.", icon: "refresh" },
          { title: "Settings", text: "Knobs + Profiles (official / local / community) + wallet vault. Slow first open shows a live Load status log so you know it isn’t stuck. See Wiki → Settings profiles.", icon: "lock" },
        ],
      },
      {
        type: "h3",
        text: "Header lights",
      },
      {
        type: "ul",
        items: [
          "ON/OFF = soft pause (no trades; positions stay open). Starts OFF after setup — you flip ON when ready. HALT = emergency close-all (confirm with dash token).",
          "PAPER / LIVE = mode. Switching live writes both gates; the farmer restarts once so the header flips to LIVE. Overview / Positions / History only show that mode’s book — paper rows stay in the DB but do not mix into live balances or activity. BRAKE appears when the cluster brake paused entries.",
          "HB = farmer alive? Shows seconds since the last finished tick (green = ok, red = stuck/missing). Not a wall clock. WS = this page’s live websocket feed.",
          "Build pill = release version + deploy branch + git SHA + sync (CURRENT / BEHIND / …). Auto-detects host: PM2/VPS uses local git; Railway/Vercel/etc use platform deploy SHA + GitHub tip for CURRENT. Changes tab is release-first (tag + notes) — not every merge commit. Pending shows newer release tags when behind; unreleased tip commits are a one-liner. GitHub API blips (403) leave the list empty briefly but never crash the dash — optional GITHUB_TOKEN raises the limit. Auto on/off next to the pill.",
          "Host name (and wallet chip when known) sit on the right.",
          "First run (and any install that has not accepted yet): Terms of Service & risk waiver must be accepted before setup continues — free software, you can lose 100%, we are not liable.",
          "Wizard reads host env (Railway variables / `.env`). Keys already set (RPC, Jupiter, GMGN, wallet) show as ready and those steps are skipped — you only fill what’s missing.",
        ],
      },
    ],
  },
  {
    id: "updates",
    title: "Updates, halt, errors",
    icon: "refresh",
    simple: "Updates can roll in automatically or wait for your Approve. Halt is the emergency brake.",
    summary: "Deploy watcher, HALT semantics, Errors tab.",
    blocks: [
      {
        type: "steps",
        items: [
          {
            title: "Auto-update ON (default)",
            text: "Header switch next to the build pill. Deploy watcher pulls when GitHub is ahead, rebuilds, restarts.",
            icon: "refresh",
          },
          {
            title: "Auto-update OFF",
            text: "Flip the same header switch. You’ll see BEHIND / APPROVE — open Changes, read the pending release notes, hit Approve.",
            icon: "lock",
          },
          {
            title: "Dashboard reload toast",
            text: "After a deploy that rebuilds the SPA, a sticky toast appears if this browser tab is still on the old UI — click Reload (or hard-refresh). Bot-only deploys do not prompt.",
            icon: "refresh",
          },
          {
            title: "Halt",
            text: "Header red HALT button → confirm with dash token → closes opens and idles until Resume.",
            icon: "alert",
          },
          {
            title: "Engine ON/OFF",
            text: "Header toggle pauses the trading engine without closing positions (PAUSE on the data volume — survives Railway redeploys). Setup leaves it OFF.",
            icon: "pause",
          },
          {
            title: "Errors",
            text: "Structured log in farmer.db (error_log) — not every PM2 line. Shows logError paths: open failures, tick crashes, RPC offline, GMGN rate limits, etc. Filter Degraded for API cooldowns. Copy, GitHub issue, or dismiss (hide). **Clear log** permanently deletes rows so the table doesn’t keep growing.",
            icon: "alert",
          },
        ],
      },
      {
        type: "p",
        text: "Repo branches: day-to-day work lands on develop (staging host); production releases land on main after you merge and run the GitHub Release workflow (semver tags). See repo RELEASE.md.",
      },
      {
        type: "p",
        text: "When auto-update is off, open Changes and Approve. Prefer reading the pending release notes — that is the operator changelog. Risk chips on raw commits are no longer shown here.",
      },
    ],
  },
  {
    id: "accounting",
    title: "Keeping score",
    icon: "calc",
    simple: "The chain is truth. We record SOL in/out, then reconcile to on-chain positions on boot.",
    summary: "Wallet-delta PnL, decisions log, repair on startup.",
    blocks: [
      {
        type: "tldr",
        text: "We care what left and returned to the wallet — not what we meant to do. Startup repairs the DB if the chain disagrees.",
      },
      {
        type: "ul",
        items: [
          "Per position: wallet SOL out → back + fees + profit-lock withdrawals − costs (REALIZED_PNL). Close rows show Move (deposit/IL) vs Fees separately.",
          "A close row splits into additive parts: Move + Fees + Recovered + Pending = PnL. Move is what came back through the close itself (IL and tx costs), Fees is income, Recovered is SOL the sweep fetched back afterwards, Pending is residue it hasn't sold yet. Each is a different route the money took, so they add up — never double-count Recovered on top of Move.",
          "Unknown outcomes stay unknown: force-closed or orphan-repaired rows have no exit value, so they're excluded from realized PnL (and from the breaker/Kelly) instead of counting as fake full losses.",
          "Under-filled closes aren't phantom losses: if the exit swap leaves tokens in the wallet, they're carried at their quoted value until the sweep sells them (usually minutes), so the breaker and Kelly don't react to a loss that never happened. If the sweep can't sell within 30 minutes it stops counting and the loss shows in full.",
          "Paper and live books are fully separate — each mode's positions, Activity entries/skips, sizing history, and brakes only ever see their own rows, even though they share one database.",
          "Majors rotation often nets ~0 SOL — small fees offset by IL/tx on a flat exit; check the Fees line, not just headline PnL.",
          "decisions table = why we entered, skipped, or exited (your future tuning gold).",
          "USD may show for readability; SOL is the scoreboard.",
        ],
      },
    ],
  },
  {
    id: "failure-modes",
    title: "Reality checks",
    icon: "alert",
    simple: "Fees fight rent and rugs. Sizing and skips are the real seatbelts.",
    summary: "Costs we accept — and ideas we refuse to ship casually.",
    blocks: [
      {
        type: "cards",
        items: [
          {
            title: "Rent & gas drag",
            text: "Bins and txs cost SOL. Budgets + reclaim on close matter.",
            icon: "coins",
          },
          {
            title: "Slow rugs exist",
            text: "Safety can’t catch everything. Caps and stops are the defense.",
            icon: "shield",
            tone: "danger",
          },
          {
            title: "RPC blips",
            text: "No panic close-all. Heartbeat shows liveness; we resume when RPC returns.",
            icon: "pause",
          },
        ],
      },
      {
        type: "callout",
        tone: "warn",
        title: "Don’t “fix” without a closed-book sample",
        text: "Flipping meme BidAsk→Spot, adding SOL-USDC, weakening stops, or loosening follow volume feels clever and often isn’t. Change with evidence.",
      },
    ],
  },
  {
    id: "profiles",
    title: "Settings profiles",
    icon: "layers",
    simple: "Presets for Bot settings. Share to the community gallery from the browser — Railway is fine; you do not need git on the host.",
    summary: "Official / local / community packs, and how to open a GitHub PR without cloning.",
    blocks: [
      {
        type: "tldr",
        text: "Settings → Profiles: apply a pack (with a diff preview), save your own on the volume, or share via Share to GitHub. Sharing is copy-paste + github.com — fork when GitHub asks.",
      },
      {
        type: "cards",
        items: [
          {
            title: "Official",
            text: "Conservative / Balanced / Aggressive / Research Base shipped in the repo. Preview shows what will change before Apply. Research Base = STRATEGY §11 + playbook knobs.",
            icon: "check",
          },
          {
            title: "My profiles",
            text: "Saved on your data volume (Railway disk / local data/). Private to your bot until you share.",
            icon: "lock",
          },
          {
            title: "Community",
            text: "Gallery loaded from GitHub profiles/community. Apply like any other pack. Gallery cache ~10 minutes.",
            icon: "book",
          },
        ],
      },
      {
        type: "callout",
        tone: "fg",
        title: "Safety",
        text: "Profiles never flip paper/live, never touch RPC/wallet secrets, and never change product fees. Only allowlisted Bot settings knobs.",
      },
      {
        type: "h3",
        text: "Share to GitHub (Railway / browser)",
      },
      {
        type: "p",
        text: "You do not clone the bot to a PC and you do not run git on Railway. Stay logged into github.com in the browser.",
      },
      {
        type: "steps",
        items: [
          {
            title: "Open Share to GitHub",
            text: "Settings → Profiles. Optional: type a name first so the file slug matches. The modal walks you through the rest.",
            icon: "layers",
          },
          {
            title: "Copy JSON + index row",
            text: "Step 1 copies the profile file. Step 2 copies the object to paste into profiles/community/index.json (same PR).",
            icon: "check",
          },
          {
            title: "Create file — fork if asked",
            text: "Create <slug>.json opens GitHub. If you cannot push to CryptoGnome/dlmmbot, choose Fork this repository — that is normal. You edit your fork, then open a PR upstream.",
            icon: "lock",
          },
          {
            title: "Edit index.json + open PR",
            text: "Add your row to the profiles array on the same fork branch, then Contribute → Open pull request. After merge, the gallery picks it up (cache ~10 min).",
            icon: "refresh",
          },
        ],
      },
      {
        type: "callout",
        tone: "warn",
        title: "Fork = expected",
        text: "Most operators are not collaborators. GitHub’s fork prompt is the path — not a bug. Full write-up: dlmmbot.com/setup/profiles",
      },
    ],
  },
  {
    id: "glossary",
    title: "Word list",
    icon: "book",
    simple: "Quick meanings for words you’ll see in Activity and Settings.",
    summary: "Tiny dictionary.",
    blocks: [
      {
        type: "table",
        headers: ["Word", "Plain meaning"],
        rows: [
          ["BidAsk", "Stack SOL under (or around) price — meme default."],
          ["Spot", "Spread evenly across bins — majors style."],
          ["Kelly", "Adaptive size from your closed-trade ledger (default sizing mode)."],
          ["Fixed sizing", "Exact SOL or % of deployable per sleeve — Settings → Book & size."],
          ["Active bin", "Where the pool’s price is right now."],
          ["Swap", "Jupiter converts the token side back into SOL when we exit."],
          ["Escape hatch", "Deep dip, then recovery → close and free the slot (reset), not a slow bleed."],
          ["Profit lock", "Bank a slice of a big winner while the rest keeps earning."],
          ["Usage fee", "1% on live wins → GNME buy+burn. See dlmmbot.com/setup/fees."],
          ["Profile", "Pack of Bot settings — official / local / GitHub community. See Wiki → Settings profiles."],
          ["Follow", "Careful re-entries after an up-and-out close."],
          ["Cluster brake", "Too many hard stops close together → pause new entries."],
          ["HALT", "Emergency stop file/flag — close book, idle."],
          ["Sleeve", "Which playbook: micro, meme, or majors."],
        ],
      },
    ],
  },
];

export function wikiSectionById(id: string | null | undefined): WikiSection {
  return WIKI_SECTIONS.find((s) => s.id === id) ?? WIKI_SECTIONS[0];
}
