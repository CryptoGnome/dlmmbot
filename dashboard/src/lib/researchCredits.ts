/** Curated X/Twitter credits — people whose public LP talk shaped DLMM Bot. */
export type Credit = {
  handle: string;
  name: string;
  role: string;
  note: string;
  /** Optional when the STRATEGY nickname has no stable public handle. */
  url?: string;
};

const REPO = "https://github.com/CryptoGnome/dlmmbot";

/** Prefills a GitHub issue so users can contribute research for agent review. */
export function researchSuggestionIssueUrl(): string {
  const title = "Research suggestion: ";
  const body = [
    "## What should we look at?",
    "",
    "<!-- Link, handle, video, essay, Discord lore — anything public -->",
    "",
    "- **Link / handle:** ",
    "- **One-line summary:** ",
    "",
    "## Why it might matter for DLMM Bot",
    "",
    "<!-- Fees, range shape, exits, sizing, sleeves, risk — be concrete -->",
    "",
    "",
    "",
    "## Where it might land",
    "",
    "- [ ] STRATEGY.md note",
    "- [ ] Research page credit",
    "- [ ] Config / gate idea",
    "- [ ] Not sure — just review it",
    "",
    "<!-- An agent will triage this against our ledger before we note it in strategy. -->",
  ].join("\n");

  const q = new URLSearchParams({
    template: "research_suggestion.md",
    title,
    body,
  });
  return `${REPO}/issues/new?${q.toString()}`;
}

export const RESEARCH_CREDITS: Credit[] = [
  {
    handle: "Tuuxxdotsol",
    name: "Tuuxx",
    role: "Playbook & coaching",
    note: "Public DLMM results threads and LP Army coaching. Core one-sided SOL BidAsk thinking that sits under our Tux/Gmet-shaped strategy.",
    url: "https://x.com/Tuuxxdotsol",
  },
  {
    handle: "SenseiSOL",
    name: "SenseiSOL",
    role: "Wide BidAsk / retail ledger",
    note: "Transparent small-wallet compounding, −75% “wide and chill” BidAsk, volume-spike entries. Cross-checked against our tighter −40% planner.",
    url: "https://x.com/SenseiSOL",
  },
  {
    handle: "satsmonkes",
    name: "satsmonkes",
    role: "Multiday / milord DLMM",
    note: "Patient multiday holds and sizing talk — useful contrast to our short meme rotation book.",
    url: "https://x.com/satsmonkes",
  },
  {
    handle: "0xMrBeefman",
    name: "Mr. Beefman",
    role: "Strategy breakdowns",
    note: "Public teardown threads of winning LP wallets — helped separate marketing APR from repeatable shapes.",
    url: "https://x.com/0xMrBeefman",
  },
  {
    handle: "0xVanChu",
    name: "Van Chu",
    role: "LP discourse",
    note: "Cited with Tuuxx / Beefman / satsmonkes in our wide-BidAsk research pass — same public BidAsk family.",
    url: "https://x.com/0xVanChu",
  },
  {
    handle: "photonmiles",
    name: "Photon Miles",
    role: "Practitioner essay",
    note: "“Hours not days” meme DLMM write-up — reinforced short holds and GTFO when narrow ranges go wrong.",
    url: "https://x.com/photonmiles",
  },
  {
    handle: "met_lparmy",
    name: "LP Army",
    role: "Community hub",
    note: "Academy, bootcamps, and the public LP discourse we keep measuring against (sleeves, Spot+BidAsk stacking, risk tiers).",
    url: "https://x.com/met_lparmy",
  },
  {
    handle: "MeteoraAG",
    name: "Meteora",
    role: "Protocol",
    note: "Official DLMM docs — BidAsk / Spot / Curve shapes, single-sided deposits, dynamic fees. Ground truth for what the program can do.",
    url: "https://x.com/MeteoraAG",
  },
  {
    handle: "SOL_Decoder",
    name: "SOL Decoder",
    role: "Automation tooling",
    note: "Shared BidAsk/Spot farmer configs often cited alongside retail journeys (e.g. SenseiSOL). Product reference, not our stack.",
    url: "https://x.com/SOL_Decoder",
  },
  {
    handle: "memecoinassassin",
    name: "Mario",
    role: "LP Army creator",
    note: "Public LP Army / Content Machine voice — retail success stories that keep the community sharp.",
    url: "https://x.com/memecoinassassin",
  },
  {
    handle: "MikusLP",
    name: "Mikus",
    role: "LP Army creator",
    note: "Community education and tooling around sustainable Meteora LPing.",
    url: "https://x.com/MikusLP",
  },
  {
    handle: "tendorian9",
    name: "Logical TA",
    role: "LP Army creator",
    note: "TA-flavored LP content from the LP Army hub we reviewed while designing majors parking.",
    url: "https://x.com/tendorian9",
  },
];

/** STRATEGY.md nicknames without a single stable public X we could pin. */
export const PLAYBOOK_NOTES = [
  {
    name: "Tux",
    note: "Named in STRATEGY as the one-sided SOL BidAsk “Tux entry.” Encoded as capital-preservation first, mechanical exits.",
  },
  {
    name: "Gmet",
    note: "Named in STRATEGY for dual-range / escape-hatch thinking and accumulate-SOL thesis. Second tranche is the Gmet dual-range pocket.",
  },
];
