import type { WikiSection } from "./types";

/**
 * In-dashboard operator wiki. Keep in sync with STRATEGY.md / config.toml /
 * farmer loop when behavior changes (see .cursor/rules/wiki-sync-on-commit.mdc).
 * Bracketed values are design defaults; live knobs live in data/config.toml.
 */
export const WIKI_SECTIONS: WikiSection[] = [
  {
    id: "overview",
    title: "What this bot does",
    summary: "Capital-preservation DLMM LP on Solana — scan, vet, bid-ask SOL, exit by rules.",
    blocks: [
      {
        type: "p",
        text: "DLMM Bot is an automated Meteora DLMM liquidity farmer. It finds SOL-quoted meme/micro pools, vets the token, opens a one-sided SOL BidAsk range below price, earns fees while price trades through the range, then exits by a fixed priority state machine. PnL is denominated in SOL.",
      },
      {
        type: "callout",
        tone: "warn",
        title: "Philosophy",
        text: "Capital preservation first. The bot has no whale chat — wherever humans would “ask the group,” it takes the more defensive branch. Paper first; burner wallet only; never commit secrets.",
      },
      {
        type: "ul",
        items: [
          "Scanner builds candidates from Meteora pool data (optional GMGN discovery).",
          "Vetting hard-gates rugs / authorities / holders before any size is risked.",
          "Executor opens BidAsk (meme/micro) or Spot (majors) and manages every tick.",
          "Dashboard streams live marks, decisions, errors, and ops controls over WebSocket.",
        ],
      },
      {
        type: "p",
        text: "Canonical written spec: STRATEGY.md in the repo. This Wiki is the operator-facing mirror — if behavior changes, both should change in the same commit.",
      },
    ],
  },
  {
    id: "architecture",
    title: "Architecture",
    summary: "Farmer loop, dashboard server, SQLite, deploy watcher, heartbeat.",
    blocks: [
      {
        type: "table",
        headers: ["Piece", "Role"],
        rows: [
          ["Farmer (`npm run run` / PM2 `meteora-farmer`)", "Scan → vet → open → manage → close. Owns the strategy state machine."],
          ["Dashboard server (`meteora-dash` :8787)", "Serves the SPA, `/api/*`, WebSocket live book + history + errors."],
          ["Deploy watcher (`meteora-deploy`)", "Pulls GitHub updates (auto or Approve-on-Changes), rebuilds, restarts PM2."],
          ["SQLite `data/farmer.db`", "Positions, events, decisions, blacklist, token meta, error_log."],
          ["`data/config.toml` + vault", "Runtime knobs + encrypted wallet (gitignored). Repo `config.toml` is the template."],
          ["Heartbeat", "Out-of-process liveness check — stale heartbeat shows OFF on the shell."],
        ],
      },
      {
        type: "h3",
        text: "Modes",
      },
      {
        type: "ul",
        items: [
          "paper (default): full pipeline against live pools; DB rows flagged paper; no real fills.",
          "live: requires FARMER_MODE=live AND [exec].mode = \"live\". Key never sits in scanner code paths.",
        ],
      },
      {
        type: "callout",
        tone: "accent",
        title: "Hot reload",
        text: "Config edits from Settings PATCH the live TOML. Strategy values in this Wiki are descriptive — the running bot always follows config.toml.",
      },
    ],
  },
  {
    id: "sleeves",
    title: "Three sleeves",
    summary: "micro · meme · majors — one scanner, different size/shape/manage rules.",
    blocks: [
      {
        type: "table",
        headers: ["Sleeve", "Who enters", "Range", "Sizing notes"],
        rows: [
          ["micro", "Meme scanner, mcap ~$100k–$200k", "BidAsk (meme planner)", "0.5× Kelly, max 1 slot, tight wallet deploy cap"],
          ["meme", "Meme scanner, mcap ≥ ~$200k", "BidAsk below price", "Main book — Kelly + score multiplier"],
          ["majors", "Allowlisted SOL-quoted alts + TA timing", "Spot (uniform bins)", "Fixed size; separate manage; after meme when slots reserved"],
        ],
      },
      {
        type: "ul",
        items: [
          "Sleeve is stamped at entry and drives manage rules for that position’s life.",
          "Majors runs after meme entries when open slots ≤ meme_reserve_slots (keeps headroom for hot memes).",
          "Stable pairs (SOL-USDC etc.) are permanently out of scope.",
        ],
      },
    ],
  },
  {
    id: "scanning",
    title: "Scanning & gates",
    summary: "Pool sweep, symbol dedupe, hard pool/token gates, opportunity score.",
    blocks: [
      {
        type: "ol",
        items: [
          "Sweep Meteora DLMM pools (TVL floor, fee/TVL sort, a few pages).",
          "Dedupe by mint; copycat symbols lose to the highest 24h volume mint (losers blacklisted ~24h).",
          "Pick best pool per token (fee/TVL), run pool gates, score, then vet.",
        ],
      },
      {
        type: "h3",
        text: "Hard pool gates (examples)",
      },
      {
        type: "ul",
        items: [
          "TVL band, fee/TVL 24h + 30m floors, volume 30m + volume trend.",
          "Base fee band, bin step for young tokens, SOL quote required.",
          "Pool price vs Jupiter divergence cap (empty-pool / oracle trap).",
          "Fee collection preference: quote-only (SOL) scored higher; both-token still eligible.",
        ],
      },
      {
        type: "h3",
        text: "Hard token / vet gates",
      },
      {
        type: "ul",
        items: [
          "Mint + freeze authority revoked; Token-2022 without fee/hook extensions.",
          "Holder concentration + insider/funding clusters under caps.",
          "Creator with any prior rug → permanent blacklist.",
          "RugCheck score is a veto only (never an approval).",
          "Age window (survive instant rugs; meme mode also has a max age).",
        ],
      },
      {
        type: "p",
        text: "Soft timing (freefall, ATH blast, buy/sell imbalance) feeds the 0–100 opportunity score used for sizing and queue priority — it does not replace hard gates.",
      },
    ],
  },
  {
    id: "entry",
    title: "Entry execution",
    summary: "Tux BidAsk below price, bin rent budgets, slip rebuild, optional second tranche.",
    blocks: [
      {
        type: "ol",
        items: [
          "Swing high/low from short OHLCV; range top ≈ active bin; bottom = shallower of fib / max-down, floored by min depth.",
          "Map to bin IDs (≤69 bins per position account; split at most once if needed).",
          "Respect bin-rent soft budget; quote uninitialized arrays on-chain; never more than two arrays.",
          "initializePositionAndAddLiquidityByStrategy — BidAsk, SOL side only (totalXAmount = 0).",
          "Open slippage rebuilt on ExceededBinSlippageTolerance instead of blind resend.",
        ],
      },
      {
        type: "callout",
        tone: "ok",
        title: "Exits / claims use Zap when enabled",
        text: "Live path: removeLiquidity then token→SOL via Meteora Zap SDK (Jupiter under the hood), with lite Jupiter fallback. P0 safety exits use wider swap slippage (speed over price).",
      },
      {
        type: "p",
        text: "High-score entries may open a second BidAsk tranche deeper below the primary (skipped on micro, or when slots/size floor block it). Tranches count toward max positions.",
      },
    ],
  },
  {
    id: "exits",
    title: "Manage priorities (P0–P5)",
    summary: "Strict order every poll — higher letter preempts lower.",
    blocks: [
      {
        type: "callout",
        tone: "danger",
        title: "Priority is absolute",
        text: "Each open position is polled on the manage tick. The first matching rule wins; lower rules never run that tick.",
      },
      {
        type: "table",
        headers: ["Pri", "Name", "What fires it", "Action"],
        rows: [
          ["P0", "Safety", "TVL collapse, dump/whale, rug signals, metadata flip, violent −price", "Close immediately, dump token→SOL, blacklist mint+creator"],
          ["P1", "Stop loss", "Mark-to-market SOL < entry × stop fraction", "Close, realize loss, ~24h re-entry cooldown"],
          ["P2", "Rotation", "Fee/vol died for N polls, or aged out of meme window", "Close; capital rotates to the queue"],
          ["P3", "Above range", "Price sustained above top (win) or never entered (missed)", "Close via zap; win vs missed use different sustain timers"],
          ["P4", "In range", "Earning — claims, escape hatch, profit lock", "Claim/bank fees; optional partial withdraw; reshape escape"],
          ["P5", "Below range", "100% token after grace wick window", "Close, swap all token→SOL, cooldown"],
        ],
      },
      {
        type: "h3",
        text: "P3 win vs missed",
      },
      {
        type: "ul",
        items: [
          "Win: price dipped into range then recovered above — fees + round-trip edge. Shorter sustain (follow can arm).",
          "Missed: price pumped without ever trading our bins — idle capital. Longer sustain (~45m live) to stop rent churn.",
        ],
      },
      {
        type: "h3",
        text: "P4 extras",
      },
      {
        type: "ul",
        items: [
          "Claims when unclaimed fees beat a SOL / tx-cost threshold (or on a time cadence).",
          "Fee destination bank = swap token fees→SOL to wallet (live default). Compound is restricted.",
          "Escape hatch: deep dip then recovery toward range top → reshape in place (or close+reenter fallback).",
          "Profit lock: mark ≥ entry × threshold → partial removeLiquidity once, zap withdrawn leg to SOL, leave rest earning.",
        ],
      },
    ],
  },
  {
    id: "follow",
    title: "Follow mode (P3-F)",
    summary: "Up-only re-entry chains after an up-and-out close — volume + retrace gated.",
    blocks: [
      {
        type: "p",
        text: "Any P3 close (win or missed) on a main position can arm a follow chain. Legs only open when volume is hot, fee heat is current (not a stale 24h average), price has retraced from the post-exit high, and fresh vetting still passes.",
      },
      {
        type: "ul",
        items: [
          "Range: tighter BidAsk (~30% depth), top at current price; escape hatch off on follow legs.",
          "Up-only: after a leg closes up-and-out, re-arm only once price makes a new chain high.",
          "Chain ends on non-P3 close, max legs, cumulative PnL floor, cold volume streak, age, blacklist, or vet fail.",
          "While a chain is live, the normal pipeline skips that mint (one owner of re-entry timing).",
        ],
      },
      {
        type: "callout",
        tone: "warn",
        title: "Do not loosen casually",
        text: "Follow volume/retrace gates were chosen from simulation — unguarded chasing was negative-EV. Prefer evidence in the closed book before changing min_vol / retrace knobs.",
      },
    ],
  },
  {
    id: "sizing",
    title: "Sizing & portfolio risk",
    summary: "Kelly, slots, circuit breaker, cluster brake, regime, halt.",
    blocks: [
      {
        type: "ul",
        items: [
          "Bankroll = burner wallet; operational reserve + % holdback never deployed.",
          "Max concurrent positions from config (tranches count). Effective slots shrink if bankroll can’t fund min size.",
          "Half-Kelly (or tighter live fraction) from your own closed ledger; cold-start flat %; hard wallet % cap; min SOL floor.",
          "Score multiplier tilts size within the Kelly budget; per-token / per-creator caps apply.",
          "Circuit breaker: rolling daily loss % → pause new entries. Cluster brake: clustered P0/P1 → short entry pause.",
          "Regime filter: sharp SOL/USD dump → halve sizes or pause entries.",
          "Alpha slot + displacement: elite scores can take reserved slots / displace weak fresh positions under strict rules.",
        ],
      },
      {
        type: "callout",
        tone: "danger",
        title: "Kill switch",
        text: "HALT (Overview Halt, npm run halt, or HALT file) closes all opens, swaps toward SOL, and idles until Resume — PM2 does not restart-loop while halted.",
      },
    ],
  },
  {
    id: "skips",
    title: "Skips & blacklist",
    summary: "What never enters, what cools off, what is permanent.",
    blocks: [
      {
        type: "table",
        headers: ["Class", "Examples"],
        rows: [
          ["Permanent", "Creator rugs, P0 tokens, Token-2022 fee/hook extensions"],
          ["~24h", "Copycat symbol losers, hard vet fails, loss exits"],
          ["Structural skip", "Arb-only fees, non-SOL quote, position would be >~20% of pool TVL"],
        ],
      },
      {
        type: "p",
        text: "Every skip/exit reason lands in decisions / events so you can tune gates from evidence instead of vibes. Activity and Analytics surface those outcomes.",
      },
    ],
  },
  {
    id: "dashboard",
    title: "Dashboard map",
    summary: "What each left-rail tab is for.",
    blocks: [
      {
        type: "table",
        headers: ["Tab", "Use it for"],
        rows: [
          ["Overview", "Wallet / open PnL flash, Halt/Resume, equity chart (7d·30d·all), high-level live book"],
          ["Book", "Open positions + closed history (same range control as equity)"],
          ["Analytics", "Equity + exit mix + skip reasons; range tabs sit on the equity chart"],
          ["Activity", "Streaming decisions — entries, exits, skips, claims, fails"],
          ["Errors", "Structured runtime failures (copy dump / open GitHub issue)"],
          ["Research", "Public voices we studied — credits, not signals"],
          ["Wiki", "This operator manual (you are here)"],
          ["Changes", "Pending Git commits, risk chips, Approve when auto-update is off"],
          ["Settings", "Bot knobs, wallet vault, auto-update toggle"],
        ],
      },
      {
        type: "ul",
        items: [
          "Shell pills: ON/OFF (heartbeat), WS, PAPER/LIVE, HALTED/BRAKE when active, build CURRENT|BEHIND|DIRTY; host name on the right.",
          "Setup docs (external) cover Railway / PM2 install — linked as Docs under the nav.",
          "Token icons: Jupiter → Pump.fun coins API → DexScreener, cached in SQLite + browser.",
        ],
      },
    ],
  },
  {
    id: "updates",
    title: "Updates, halt, errors",
    summary: "Auto-update vs Approve, HALT semantics, error_log.",
    blocks: [
      {
        type: "h3",
        text: "Auto-update",
      },
      {
        type: "ul",
        items: [
          "Default ON for PM2 deploy watcher — pulls origin when behind.",
          "Settings → off: BEHIND build pill; use Changes → Approve to pull.",
          "Pending commits show risk tags from changed paths: strategy, deps, deploy, core, dash, docs.",
        ],
      },
      {
        type: "h3",
        text: "Halt / Resume",
      },
      {
        type: "ol",
        items: [
          "Confirm with dash token on Overview Bot control (or CLI npm run halt / resume).",
          "Farmer closes opens, then idles on the manage loop while HALT exists.",
          "Resume deletes HALT; next tick resumes entries/manage.",
        ],
      },
      {
        type: "h3",
        text: "Errors tab",
      },
      {
        type: "p",
        text: "Runtime failures are written to SQLite error_log and streamed on the watch socket. Use copy dump or “Open GitHub issue” when filing bugs — include host, mode, and the structured stack.",
      },
    ],
  },
  {
    id: "accounting",
    title: "Accounting & persistence",
    summary: "SOL unit of account, wallet-delta truth, reconciliation on boot.",
    blocks: [
      {
        type: "ul",
        items: [
          "Per position: fees claimed + unclaimed + (exit − entry) − rent − tx, in SOL.",
          "Wallet-delta / measured true PnL preferred over intent when both exist.",
          "On startup, on-chain DLMM positions win — DB is repaired to match.",
          "decisions table is the tuning dataset (entered / skipped / exited + gate vector).",
        ],
      },
    ],
  },
  {
    id: "failure-modes",
    title: "Costs & failure modes",
    summary: "What we accept; what not to “fix” without evidence.",
    blocks: [
      {
        type: "ul",
        items: [
          "Bin rent and position rent are real drag — budgets + reclaim on close matter.",
          "Slow rugs can beat safety triggers; sizing caps are the real defense.",
          "RPC outage: no blind close-all — heartbeat is liveness; manager resumes when RPC returns.",
          "Open bin-slippage used to burn every tick at 1%; live uses wider open slip + rebuild.",
        ],
      },
      {
        type: "callout",
        tone: "warn",
        title: "Do not ship without review",
        text: "Meme BidAsk→Spot/Curve flip, SOL-USDC pairs, weakening P1, house-money rule, looser follow volume, or more slots without a closed-book sample.",
      },
    ],
  },
  {
    id: "glossary",
    title: "Glossary",
    summary: "Quick definitions used across Activity and STRATEGY.",
    blocks: [
      {
        type: "table",
        headers: ["Term", "Meaning"],
        rows: [
          ["BidAsk", "One-sided SOL liquidity stacked below (or around) price — meme/micro default."],
          ["Spot", "Uniform bin distribution — majors sleeve."],
          ["Active bin", "Current price bin in the DLMM pool."],
          ["Zap", "Meteora Zap SDK path token→SOL after removeLiquidity."],
          ["Escape hatch", "Deep-dip-then-recover reshape (or close fallback)."],
          ["Profit lock", "One-shot partial withdraw while still in range."],
          ["Follow chain", "Volume/retrace-gated legs after P3 up-and-out."],
          ["Cluster brake", "Pause entries after clustered hard stops."],
          ["HALT", "File/flag that closes book and idles the farmer."],
          ["Sleeve", "micro | meme | majors stamped at entry."],
        ],
      },
    ],
  },
];

export function wikiSectionById(id: string | null | undefined): WikiSection {
  return WIKI_SECTIONS.find((s) => s.id === id) ?? WIKI_SECTIONS[0];
}
