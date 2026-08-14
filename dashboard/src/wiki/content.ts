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
            text: "Allowlisted SOL-quoted alts. Spot (flat) bins + separate timing. Runs after memes so hot memes keep slots.",
            icon: "layers",
          },
        ],
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
          "Brand-new tokens wait out the instant-rug window; old memes can age out of meme mode.",
        ],
      },
      {
        type: "callout",
        tone: "fg",
        title: "Soft stuff only tilts size",
        text: "Freefall, ATH blast, sell pressure — these change the score (how big / how soon), they don’t secretly override a hard fail.",
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
            text: "When we leave, Zap (or Jupiter fallback) turns leftover tokens back into SOL.",
            icon: "bank",
          },
        ],
      },
      {
        type: "p",
        text: "Very high scores may add a second, deeper “tranche” pocket. Tranches count toward your max open slots.",
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
            then: "Close, dump token→SOL fast, blacklist mint + creator",
            tone: "danger",
          },
          {
            code: "P1",
            title: "Stop loss",
            when: "Position value in SOL fell too far vs entry",
            then: "Close, take the loss, cool the token ~24h",
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
            then: "Close via zap; wins exit faster than misses (misses wait longer so we don’t churn rent)",
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
          { label: "P3 close", detail: "Arms the chain", icon: "exit" },
          { label: "Wait", detail: "Volume + retrace", icon: "pause" },
          { label: "Leg open", detail: "Tighter BidAsk", icon: "entry" },
          { label: "Up-and-out", detail: "Need a new high to re-arm", icon: "chart" },
          { label: "End", detail: "Cold vol / loss / max legs", icon: "x", tone: "danger" },
        ],
      },
      {
        type: "ul",
        items: [
          "While a follow chain owns a mint, the normal scanner won’t double-book it.",
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
          { label: "Score tilt", detail: "Scan score picks low/mid/high multiplier on the result." },
          { label: "Floors", detail: "Never below min position size; negative edge can block or clamp to floor." },
        ],
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
            text: "Bad day % or a cluster of hard stops → pause new entries for a cool-down (measured from the newest hard exit). Applies to follow-mode legs too.",
            icon: "pause",
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
          { title: "Overview", text: "Money snapshot, open profit with slot occupancy (e.g. 3 of 5 · 2 free), equity chart. Engine ON/OFF + HALT live in the header.", icon: "chart" },
          { title: "Positions", text: "Open positions (slot badge) + recent closes. Range bar: purple ≈ SOL still waiting, blue ≈ already converted to token as price walks the bins.", icon: "book" },
          { title: "Analytics", text: "Why we made/lost SOL — exits, sleeves, skips.", icon: "calc" },
          { title: "Activity", text: "Live play-by-play. SOL: green in / win, blue deployed (entries), red only for losses. On-chain rows link to Solscan.", icon: "zap" },
          { title: "Errors", text: "Broken stuff with copy/paste for bug reports. Each row has a plain label (Transient / Degraded / Needs attention).", icon: "alert", tone: "danger" },
          { title: "Report", text: "Bug or enhancement — guided GitHub issue with type/area chips, optional screenshots (paste in GitHub), and auto build context.", icon: "alert" },
          { title: "Research", text: "People we studied — not trade signals.", icon: "book" },
          { title: "Wiki", text: "This guided tour.", icon: "bot" },
          { title: "Changes", text: "Pending Git updates + Approve if auto-update is off.", icon: "refresh" },
          { title: "Settings", text: "Knobs + Profiles (official / local / community) + wallet vault. See Wiki → Settings profiles.", icon: "lock" },
        ],
      },
      {
        type: "h3",
        text: "Header lights",
      },
      {
        type: "ul",
        items: [
          "ON/OFF = soft pause (no trades; positions stay open). HALT = emergency close-all (confirm with dash token).",
          "HB = farmer alive? Shows seconds since the last finished tick (green = ok, red = stuck/missing). Not a wall clock. WS = this page’s live websocket feed.",
          "PAPER / LIVE = mode. BRAKE appears when the cluster brake paused entries.",
          "Build pill = release version + deploy branch + git SHA + sync (CURRENT / BEHIND / …). Auto on/off switch sits next to it (host pulls vs Changes → Approve).",
          "Host name (and wallet chip when known) sit on the right.",
          "First run (and any install that has not accepted yet): Terms of Service & risk waiver must be accepted before setup continues — free software, you can lose 100%, we are not liable.",
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
            text: "Flip the same header switch. You’ll see BEHIND / APPROVE — open Changes, read risk chips, hit Approve.",
            icon: "lock",
          },
          {
            title: "Halt",
            text: "Header red HALT button → confirm with dash token → closes opens and idles until Resume.",
            icon: "alert",
          },
          {
            title: "Engine ON/OFF",
            text: "Header toggle pauses the trading engine without closing positions (PAUSE file).",
            icon: "pause",
          },
          {
            title: "Errors",
            text: "Labeled log: Transient = API blip (auto-retries), Degraded = partial, Needs attention = review. Copy, GitHub issue, or dismiss.",
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
        text: "Risk chips on pending commits (strategy / deps / deploy / core / dash / docs) are a quick “how spicy is this update?” hint — not a substitute for reading the subjects.",
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
          "Unknown outcomes stay unknown: force-closed or orphan-repaired rows have no exit value, so they're excluded from realized PnL (and from the breaker/Kelly) instead of counting as fake full losses.",
          "Paper and live books are fully separate — each mode's positions, sizing history, and brakes only ever see their own rows, even though they share one database.",
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
            text: "Conservative / Balanced / Aggressive shipped in the repo. Preview shows what will change before Apply.",
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
          ["Zap", "Helper that turns leftover tokens into SOL when we exit."],
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
