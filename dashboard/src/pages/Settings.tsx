import { useEffect, useMemo, useState } from "react";
import {
  fetchConfig, fetchEnv, fetchSetupStatus,
  patchConfig, patchSecrets, unlockSecrets, unlockWallet,
  type EnvRow, type FlatConfig, type SetupStatus,
} from "@/lib/api";
import { Badge, LoadingState, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { toast } from "@/lib/toast";
import { WalletCreateModal } from "@/components/WalletCreateModal";
import { ProfilesPanel } from "@/components/ProfilesPanel";
import { walletPresence } from "@/lib/walletStatus";
import {
  Settings as SettingsIcon, Save, RefreshCw, Lock, Unlock, KeyRound, Wallet,
} from "lucide-react";

type Field =
  | { path: string; label: string; help?: string; kind: "bool" }
  | { path: string; label: string; help?: string; kind: "text" }
  | { path: string; label: string; help?: string; kind: "select"; options: { value: string; label: string }[] }
  | { path: string; label: string; help?: string; kind: "int"; min: number; max: number; step?: number; suffix?: string }
  | { path: string; label: string; help?: string; kind: "sol"; min: number; max: number; step: number }
  | { path: string; label: string; help?: string; kind: "usd"; min: number; max: number; step: number }
  | {
      path: string; label: string; help?: string; kind: "pct";
      min: number; max: number; step: number;
      /** frac: config 0.75 ↔ UI 75%. pct: config 20 ↔ UI 20%. */
      scale: "frac" | "pct";
      hint?: (ui: number) => string;
    };

type Group = {
  title: string;
  blurb?: string;
  /** Grid columns for fields (default 3). Use 2 for toggle+slider pairs. */
  cols?: 2 | 3 | 4;
  /** Pair each toggle with following sliders as clear rows (Token safety). */
  layout?: "grid" | "gates";
  fields: Field[];
};

const GROUPS: Group[] = [
  {
    title: "Book & size",
    blurb: "How many positions and how big they can get.",
    cols: 4,
    fields: [
      { path: "sizing.max_positions", label: "Max open positions", kind: "int", min: 1, max: 10 },
      { path: "sizing.min_position_sol", label: "Minimum size", kind: "sol", min: 0.1, max: 2, step: 0.1 },
      {
        path: "sizing.kelly_max_position_frac",
        label: "Max share of wallet",
        kind: "pct",
        scale: "frac",
        min: 3,
        max: 25,
        step: 1,
        help: "Hard cap for any single position.",
      },
      { path: "sizing.reserve_sol", label: "Wallet reserve", kind: "sol", min: 0.5, max: 5, step: 0.5, help: "Left alone for rent & fees." },
    ],
  },
  {
    title: "Risk",
    blurb: "Exits and fee banking.",
    cols: 4,
    fields: [
      {
        path: "manage.stop_loss_frac",
        label: "Stop loss",
        kind: "pct",
        scale: "frac",
        min: 50,
        max: 95,
        step: 1,
        hint: (ui) => `exit at ${ui}% of entry (−${100 - ui}%)`,
        help: "Close when mark value falls to this % of entry.",
      },
      { path: "manage.claim_min_sol", label: "Claim fees above", kind: "sol", min: 0.01, max: 0.5, step: 0.01 },
      { path: "manage.profit_lock_enabled", label: "Profit lock", kind: "bool", help: "Bank some profit on big runners while staying in." },
      { path: "manage.max_age_h", label: "Max hold time", kind: "int", min: 6, max: 168, step: 6, suffix: "hours" },
    ],
  },
  {
    title: "Pool filters",
    blurb: "Skip pools that don’t clear these floors (before token vetting).",
    cols: 3,
    fields: [
      { path: "gates.mcap_min_usd", label: "Min market cap", kind: "usd", min: 50_000, max: 500_000, step: 10_000 },
      { path: "gates.tvl_min_usd", label: "Min pool TVL", kind: "usd", min: 1_000, max: 50_000, step: 1_000 },
      { path: "gates.tvl_max_usd", label: "Max pool TVL", kind: "usd", min: 100_000, max: 5_000_000, step: 100_000 },
      { path: "gates.vol_30m_min_usd", label: "Min 30m volume", kind: "usd", min: 5_000, max: 100_000, step: 5_000 },
      {
        path: "gates.fee_tvl_24h_min_pct",
        label: "Min fee / TVL (24h)",
        kind: "pct",
        scale: "pct",
        min: 5,
        max: 50,
        step: 1,
        hint: (ui) => `${ui}% per day`,
      },
      {
        path: "gates.fee_tvl_30m_daily_min_pct",
        label: "Min fee momentum (30m)",
        kind: "pct",
        scale: "pct",
        min: 0,
        max: 40,
        step: 1,
        hint: (ui) => `${ui}% / day equiv.`,
      },
      {
        path: "gates.max_pool_share_pct",
        label: "Max pool share",
        kind: "pct",
        scale: "pct",
        min: 5,
        max: 40,
        step: 1,
        help: "Don’t take more than this % of pool TVL.",
      },
      {
        path: "entry.bin_rent_budget_sol",
        label: "Bin rent soft budget",
        kind: "sol",
        min: 0.05,
        max: 0.3,
        step: 0.025,
        help: "Try to shrink range to stay under this rent.",
      },
      {
        path: "entry.bin_rent_hard_sol",
        label: "Bin rent hard cap",
        kind: "sol",
        min: 0.075,
        max: 0.45,
        step: 0.025,
        help: "Skip open if estimated rent is above this (unless score is high enough).",
      },
    ],
  },
  {
    title: "Token safety",
    blurb: "Toggle a check off to stop blocking on it, or leave it on and set how strict the slider is. Paired as toggle → threshold.",
    layout: "gates",
    fields: [
      {
        path: "vetting.age_min_enabled",
        label: "Block too-young tokens",
        kind: "bool",
        help: "Uses mint age (RugCheck), not when the Meteora pool was created.",
      },
      {
        path: "vetting.age_min_minutes",
        label: "Minimum age",
        kind: "int",
        min: 0,
        max: 180,
        step: 5,
        suffix: "min",
        help: "Mint age floor. 0 = effectively off even if the toggle is on.",
      },
      {
        path: "vetting.age_max_enabled",
        label: "Block too-old tokens",
        kind: "bool",
        help: "Uses mint age (RugCheck), not Meteora pool age.",
      },
      {
        path: "vetting.age_max_days",
        label: "Maximum age",
        kind: "int",
        min: 1,
        max: 60,
        step: 1,
        suffix: "days",
      },
      {
        path: "vetting.insider_gate_enabled",
        label: "Block insider clusters",
        kind: "bool",
        help: "Skip when RugCheck / funding clusters look coordinated.",
      },
      {
        path: "vetting.insider_cluster_max_pct",
        label: "Max insider / cluster",
        kind: "pct",
        scale: "pct",
        min: 1,
        max: 50,
        step: 1,
        hint: (ui) => `fail above ${ui}%`,
      },
      {
        path: "vetting.holder_gate_enabled",
        label: "Block whale concentration",
        kind: "bool",
        help: "Skip when one wallet or the top 10 hold too much.",
      },
      {
        path: "vetting.single_holder_max_pct",
        label: "Max single holder",
        kind: "pct",
        scale: "pct",
        min: 5,
        max: 40,
        step: 1,
      },
      {
        path: "vetting.top10_max_pct",
        label: "Max top-10 holders",
        kind: "pct",
        scale: "pct",
        min: 20,
        max: 80,
        step: 1,
      },
      {
        path: "vetting.rugcheck_veto_enabled",
        label: "Block high RugCheck score",
        kind: "bool",
        help: "Skip when RugCheck risk score is at/above the veto. Rugged flag still always blocks.",
      },
      {
        path: "vetting.rugcheck_veto_normalised",
        label: "RugCheck veto at",
        kind: "int",
        min: 10,
        max: 100,
        step: 1,
        help: "Higher = more permissive.",
      },
      {
        path: "vetting.creator_rug_enabled",
        label: "Block rugger creators",
        kind: "bool",
        help: "Skip (and blacklist) creators with prior rug history.",
      },
      {
        path: "vetting.gmgn_security_enabled",
        label: "Block honeypot / sell tax",
        kind: "bool",
        help: "Use GMGN security flags when available.",
      },
    ],
  },
  {
    title: "Special features",
    blurb: "Extra entry / manage behaviors.",
    cols: 2,
    fields: [
      { path: "entry.tranche_enabled", label: "Second tranche", kind: "bool", help: "Extra BidAsk pocket under high-score primaries." },
      { path: "follow.enabled", label: "Follow re-entry", kind: "bool", help: "Small legs after a clean above-range exit." },
      {
        path: "manage.reentry_max_per_24h",
        label: "Max re-entries / 24h",
        kind: "int",
        min: 0,
        max: 5,
        help: "Same-token opens in a day. 0 = no re-entry ladder opens.",
      },
      {
        path: "manage.loss_reentry_cooldown_h",
        label: "Loss re-entry cooldown",
        kind: "int",
        min: 0,
        max: 72,
        step: 6,
        suffix: "hours",
        help: "Don’t reopen a mint after a losing close until this cools off.",
      },
      {
        path: "rotation.displacement_enabled",
        label: "Displacement",
        kind: "bool",
        help: "Let a hotter alpha candidate kick out a weaker open position.",
      },
      { path: "gmgn.enabled", label: "GMGN trending bonus", kind: "bool", help: "Score bonus from GMGN trending (needs API key)." },
    ],
  },
  {
    title: "Majors parking",
    blurb: "Separate sleeve for SOL-quoted majors (ANSEM, PUMP, …).",
    cols: 3,
    fields: [
      { path: "majors.enabled", label: "Enabled", kind: "bool" },
      { path: "majors.size_sol", label: "Position size", kind: "sol", min: 0.25, max: 3, step: 0.25 },
      { path: "majors.max_slots", label: "Max majors slots", kind: "int", min: 0, max: 3 },
      { path: "majors.symbol_allowlist", label: "Allowlist", kind: "text", help: "Comma-separated, e.g. PUMP, ANSEM, JUP." },
    ],
  },
  {
    title: "Mode",
    cols: 2,
    fields: [
      {
        path: "exec.mode",
        label: "Execution mode",
        kind: "select",
        options: [
          { value: "paper", label: "Paper" },
          { value: "live", label: "Live" },
        ],
        help: "Live also needs FARMER_MODE=live in the process env.",
      },
    ],
  },
];

type GateRow =
  | { kind: "gate"; gate: Field; knobs: Field[] }
  | { kind: "loners"; fields: Field[] }
  | { kind: "plain"; fields: Field[] };

function chunkGateRows(fields: Field[]): GateRow[] {
  const rows: GateRow[] = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i]!;
    if (f.kind !== "bool") {
      const plain: Field[] = [];
      while (i < fields.length && fields[i]!.kind !== "bool") plain.push(fields[i++]!);
      rows.push({ kind: "plain", fields: plain });
      continue;
    }
    const gate = fields[i++]!;
    const knobs: Field[] = [];
    while (i < fields.length && fields[i]!.kind !== "bool") knobs.push(fields[i++]!);
    if (knobs.length > 0) {
      rows.push({ kind: "gate", gate, knobs });
      continue;
    }
    const loners: Field[] = [gate];
    while (i < fields.length && fields[i]!.kind === "bool") {
      let j = i + 1;
      while (j < fields.length && fields[j]!.kind !== "bool") j += 1;
      if (j > i + 1) break;
      loners.push(fields[i++]!);
    }
    rows.push({ kind: "loners", fields: loners });
  }
  return rows;
}

const PUBLIC_PATHS = new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.path)));

const SECRET_LABELS: Record<string, string> = {
  RPC_URL: "RPC URL (required)",
  RPC_URL_FALLBACK: "Backup RPC (optional)",
  WALLET_PUBKEY: "Wallet address",
  PUBLIC_WALLET: "Public wallet (legacy)",
  WALLET_PRIVATE_KEY: "Private key (advanced)",
  WALLET_KEYPAIR_PATH: "Key file path (advanced)",
  JUPITER_API_KEY: "Jupiter API key",
  GMGN_API_KEY: "GMGN API key (optional)",
  TELEGRAM_BOT_TOKEN: "Telegram bot token (optional)",
  TELEGRAM_CHAT_ID: "Telegram chat id (optional)",
  FARMER_MODE: "Bot mode (paper / live)",
};

/** Keys most operators actually need — rest stay under “More”. */
const SECRET_PRIMARY = new Set([
  "RPC_URL",
  "RPC_URL_FALLBACK",
  "JUPITER_API_KEY",
  "FARMER_MODE",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
]);

const SECRET_IS_PASSWORD = new Set([
  "WALLET_PRIVATE_KEY",
  "JUPITER_API_KEY",
  "GMGN_API_KEY",
  "TELEGRAM_BOT_TOKEN",
]);

const SECRET_HELP: Record<string, string> = {
  RPC_URL: "Private Solana RPC from Helius / QuickNode / etc.",
  RPC_URL_FALLBACK: "Used if the primary RPC fails.",
  JUPITER_API_KEY: "Helps swaps during exits. Free key from Jupiter.",
  FARMER_MODE: 'Type "paper" or "live". Live also needs Mode → Live in Bot settings.',
  TELEGRAM_BOT_TOKEN: "Optional alerts.",
  TELEGRAM_CHAT_ID: "Optional alerts.",
  WALLET_PRIVATE_KEY: "Prefer Encrypted wallet above. Only paste here if you know why.",
  WALLET_KEYPAIR_PATH: "Rare — leave blank if you use Encrypted wallet.",
  WALLET_PUBKEY: "Usually filled automatically when you unlock.",
  PUBLIC_WALLET: "Older installs only.",
  GMGN_API_KEY: "Optional research/enrichment.",
};

function wireStr(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "number" && Number.isFinite(v)) {
    // Avoid "0.7500000001" noise — keep readable wire form.
    return String(Math.round(v * 1e9) / 1e9);
  }
  return String(v ?? "");
}

function toUi(f: Field, wire: string): number {
  const n = Number(wire);
  if (!Number.isFinite(n)) return f.kind === "pct" || f.kind === "int" || f.kind === "sol" || f.kind === "usd" ? f.min : 0;
  if (f.kind === "pct" && f.scale === "frac") return Math.round(n * 100);
  return n;
}

function fromUi(f: Field, ui: number): string {
  if (f.kind === "pct" && f.scale === "frac") {
    return wireStr(Math.round(ui) / 100);
  }
  if (f.kind === "int") return String(Math.round(ui));
  if (f.kind === "sol" || f.kind === "usd" || f.kind === "pct") {
    const step = "step" in f ? f.step : 1;
    const rounded = Math.round(ui / step) * step;
    return wireStr(Number(rounded.toFixed(6)));
  }
  return String(ui);
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${Math.round(n)}`;
}

function fmtSol(n: number): string {
  const t = Math.round(n * 100) / 100;
  return `${t} SOL`;
}

function coerce(raw: string, sample: unknown, f: Field): unknown {
  if (f.kind === "bool" || typeof sample === "boolean") return raw === "true" || raw === "1";
  if (f.kind === "text" || Array.isArray(sample)) {
    if (Array.isArray(sample) || raw.includes(",")) {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return raw;
  }
  if (f.kind === "select") return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${raw}`);
  return n;
}

function SliderRow({
  label, help, hint, changed, value, min, max, step, display, onChange,
}: {
  label: string;
  help?: string;
  hint?: string;
  changed: boolean;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col gap-1.5 border border-grid px-2.5 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`min-w-0 text-[11px] leading-snug ${changed ? "text-hover" : "text-muted"}`} title={help}>
          {label}{changed ? " *" : ""}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-fg tabular-nums">{display}</span>
      </div>
      {hint && <p className="text-[9px] leading-snug text-accent">{hint}</p>}
      <input
        type="range"
        className="slider-field mt-auto"
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        title={help}
      />
      <div className="flex justify-between text-[9px] text-dim tabular-nums">
        <span>{min >= 1000 ? fmtUsd(min) : String(min)}</span>
        <span>{max >= 1000 ? fmtUsd(max) : String(max)}</span>
      </div>
    </div>
  );
}

function fieldGridClass(cols: 2 | 3 | 4 = 3) {
  if (cols === 2) return "grid grid-cols-1 gap-2 sm:grid-cols-2";
  // Fixed counts so N fields divide evenly (4→2×2 / 4×1, 9→3×3).
  if (cols === 4) return "grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4";
  return "grid grid-cols-1 gap-2 md:grid-cols-3";
}

export function SettingsPage() {
  const [config, setConfig] = useState<FlatConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [secretsUnlocked, setSecretsUnlocked] = useState(false);
  const [confirmToken, setConfirmToken] = useState("");
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [secretsSaving, setSecretsSaving] = useState(false);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [walletTab, setWalletTab] = useState<"create" | "import" | "unlock">("create");
  const [walletConfirm, setWalletConfirm] = useState("");
  const [walletPass, setWalletPass] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [pageTab, setPageTab] = useState<"bot" | "wallet">("bot");
  const [showAdvancedSecrets, setShowAdvancedSecrets] = useState(false);
  const [walletModal, setWalletModal] = useState<"create" | "import" | null>(null);
  /** When wallet is already ready, hide create/import/unlock until user asks to replace. */
  const [walletReplaceOpen, setWalletReplaceOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [c, e, s] = await Promise.all([
        fetchConfig(), fetchEnv(), fetchSetupStatus(),
      ]);
      setConfig(c);
      const d: Record<string, string> = {};
      for (const path of PUBLIC_PATHS) {
        if (path in c) d[path] = wireStr(c[path]);
      }
      setDraft(d);
      setEnv(e);
      setSetup(s);
      if (s.wallet.encrypted) setWalletTab("unlock");
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
      setReady(true);
    }
  };

  useEffect(() => { void load(); }, []);

  const safeEnv = useMemo(() => env.filter((r) => !r.secret), [env]);
  const secretEnv = useMemo(() => env.filter((r) => r.editable), [env]);

  const dirtyCount = useMemo(() => {
    if (!config) return 0;
    let n = 0;
    for (const path of PUBLIC_PATHS) {
      if (!(path in config) || !(path in draft)) continue;
      if (draft[path] !== wireStr(config[path])) n += 1;
    }
    return n;
  }, [config, draft]);

  const secretDirty = useMemo(
    () => Object.values(secretDraft).some((v) => v.trim().length > 0),
    [secretDraft],
  );

  const setPath = (path: string, value: string) => setDraft((d) => ({ ...d, [path]: value }));

  const onUnlock = async () => {
    setErr(null);
    setMsg(null);
    try {
      await unlockSecrets(confirmToken);
      setSecretsUnlocked(true);
      setSecretDraft({});
      setMsg("Secrets unlocked — paste new values only where you want to replace. Blank keeps current.");
      toast({ title: "Secrets unlocked", tone: "ok", kind: "event" });
    } catch (e) {
      setSecretsUnlocked(false);
      setErr((e as Error).message ?? String(e));
      toast({ title: "Unlock failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    }
  };

  const onLock = () => {
    setSecretsUnlocked(false);
    setConfirmToken("");
    setSecretDraft({});
    setSecretsOpen(false);
  };

  const saveSecrets = async () => {
    if (!secretDirty) return;
    setSecretsSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const updates: Record<string, string> = {};
      for (const [k, v] of Object.entries(secretDraft)) {
        if (v.trim()) updates[k] = v;
      }
      const result = await patchSecrets(confirmToken, updates);
      setEnv(result.env);
      setSecretDraft({});
      setMsg(`${result.note ?? "Saved."} Updated: ${result.applied.join(", ") || "none"}.`);
      toast({
        title: "Secrets saved",
        detail: result.applied.join(", ") || "none",
        tone: "ok",
        kind: "event",
      });
    } catch (e) {
      setErr((e as Error).message ?? String(e));
      toast({ title: "Secrets write failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    } finally {
      setSecretsSaving(false);
    }
  };

  const save = async () => {
    if (!config || !dirtyCount) return;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const updates: Record<string, unknown> = {};
      for (const g of GROUPS) {
        for (const f of g.fields) {
          if (!(f.path in draft) || !(f.path in config)) continue;
          if (draft[f.path] === wireStr(config[f.path])) continue;
          updates[f.path] = coerce(draft[f.path]!, config[f.path], f);
        }
      }
      const result = await patchConfig(updates);
      setConfig(result.config);
      const d: Record<string, string> = {};
      for (const path of PUBLIC_PATHS) {
        if (path in result.config) d[path] = wireStr(result.config[path]);
      }
      setDraft(d);
      setMsg(`Saved ${result.applied.length} setting(s). Bot hot-reloads within ~2s.`);
      toast({
        title: `Saved ${result.applied.length} setting(s)`,
        detail: "Bot hot-reloads within ~2s",
        tone: "ok",
        kind: "event",
      });
    } catch (e) {
      setErr((e as Error).message ?? String(e));
      toast({ title: "Save failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    } finally {
      setSaving(false);
    }
  };

  const renderField = (f: Field) => {
    if (!config || !(f.path in config)) return null;
    const wire = draft[f.path] ?? wireStr(config[f.path]);
    const changed = wire !== wireStr(config[f.path]);

    if (f.kind === "bool") {
      const on = wire === "true";
      return (
        <div key={f.path} className="flex h-full min-w-0 flex-col gap-2 border border-grid px-2.5 py-2">
          <div className="min-w-0">
            <div className={`text-[11px] leading-snug ${changed ? "text-hover" : "text-muted"}`}>
              {f.label}{changed ? " *" : ""}
            </div>
            {f.help && <p className="mt-1 text-[10px] leading-snug text-dim">{f.help}</p>}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`mt-auto self-start border px-3 py-1 text-[11px] tracking-wider uppercase ${
              on ? "border-ok/50 bg-ok/10 text-ok" : "border-grid text-dim"
            }`}
            onClick={() => setPath(f.path, on ? "false" : "true")}
          >
            {on ? "On" : "Off"}
          </button>
        </div>
      );
    }

    if (f.kind === "select") {
      return (
        <label key={f.path} className="flex h-full min-w-0 flex-col gap-1.5 border border-grid px-2.5 py-2">
          <span className={`text-[11px] leading-snug ${changed ? "text-hover" : "text-muted"}`}>
            {f.label}{changed ? " *" : ""}
          </span>
          {f.help && <span className="text-[10px] leading-snug text-dim">{f.help}</span>}
          <select className="input-field mt-auto" value={wire} onChange={(e) => setPath(f.path, e.target.value)}>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      );
    }

    if (f.kind === "text") {
      return (
        <label key={f.path} className="col-span-full flex min-w-0 flex-col gap-1.5 border border-grid px-2.5 py-2">
          <span className={`text-[11px] leading-snug ${changed ? "text-hover" : "text-muted"}`}>
            {f.label}{changed ? " *" : ""}
          </span>
          {f.help && <span className="text-[10px] leading-snug text-dim">{f.help}</span>}
          <input className="input-field" value={wire} onChange={(e) => setPath(f.path, e.target.value)} />
        </label>
      );
    }

    const ui = toUi(f, wire);
    let display = String(ui);
    let hint: string | undefined;
    if (f.kind === "pct") {
      display = `${Math.round(ui)}%`;
      hint = f.hint?.(Math.round(ui));
    } else if (f.kind === "sol") {
      display = fmtSol(ui);
    } else if (f.kind === "usd") {
      display = fmtUsd(ui);
    } else if (f.kind === "int") {
      display = f.suffix ? `${Math.round(ui)} ${f.suffix}` : String(Math.round(ui));
    }

    return (
      <SliderRow
        key={f.path}
        label={f.label}
        help={f.help}
        hint={hint}
        changed={changed}
        value={ui}
        min={f.min}
        max={f.max}
        step={f.step ?? 1}
        display={display}
        onChange={(n) => setPath(f.path, fromUi(f, n))}
      />
    );
  };

  const presence = walletPresence(setup, secretEnv);
  const walletBadgeTone = presence.ready
    ? (presence.how === "encrypted_locked" ? "warn" : "ok")
    : "fg";
  const walletBadgeLabel = presence.label;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={pageTab === "bot" ? SettingsIcon : Wallet} size={18} className="text-accent" />
            Settings
          </h1>
          <p className="text-[11px] text-dim">
            {pageTab === "bot"
              ? "Bot knobs — advanced keys stay in config.toml."
              : "Burner wallet + RPC keys. Follow the numbered steps."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pageTab === "bot" && (
            <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!dirtyCount || saving} onClick={() => void save()}>
              <Icon icon={Save} size={12} />
              {saving ? "Saving…" : dirtyCount ? `Save ${dirtyCount}` : "Saved"}
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover disabled:opacity-40"
            onClick={() => void load()}
            disabled={loading}
          >
            <Icon icon={RefreshCw} size={12} className={loading ? "animate-spin" : undefined} />
            {loading ? "Loading…" : "Reload"}
          </button>
        </div>
      </div>

      <div className="flex gap-1 border border-grid p-0.5">
        <button
          type="button"
          className={`inline-flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] tracking-wider uppercase ${
            pageTab === "bot" ? "bg-ok/15 text-ok" : "text-dim hover:text-muted"
          }`}
          onClick={() => setPageTab("bot")}
          disabled={!ready}
        >
          <Icon icon={SettingsIcon} size={12} />
          Bot settings
          {dirtyCount > 0 && <Badge tone="accent">{dirtyCount}</Badge>}
        </button>
        <button
          type="button"
          className={`inline-flex flex-1 items-center justify-center gap-1.5 px-3 py-2 text-[11px] tracking-wider uppercase ${
            pageTab === "wallet" ? "bg-ok/15 text-ok" : "text-dim hover:text-muted"
          }`}
          onClick={() => setPageTab("wallet")}
          disabled={!ready}
        >
          <Icon icon={Wallet} size={12} />
          Wallet & secrets
          <Badge tone={walletBadgeTone}>
            {walletBadgeLabel}
          </Badge>
        </button>
      </div>

      {err && <div className="border border-danger/60 bg-panel px-3 py-2 text-danger text-[11px]">{err}</div>}
      {msg && <div className="border border-ok/60 bg-panel px-3 py-2 text-ok text-[11px]">{msg}</div>}
      {!ready && <LoadingState label="Loading settings…" />}

      {ready && pageTab === "bot" && (
        <ProfilesPanel
          onApplied={(next) => {
            setConfig(next);
            const d: Record<string, string> = {};
            for (const path of PUBLIC_PATHS) {
              if (path in next) d[path] = wireStr(next[path]);
            }
            setDraft(d);
            setMsg("Applied profile. Bot hot-reloads within ~2s.");
          }}
        />
      )}

      {ready && pageTab === "bot" && GROUPS.map((g) => (
        <Panel key={g.title} title={g.title} right={<Badge tone="accent">{g.fields.filter((f) => f.path in (config ?? {})).length}</Badge>}>
          {g.blurb && <p className="mb-3 text-[11px] text-dim">{g.blurb}</p>}
          {g.layout === "gates" ? (
            <div className="space-y-2">
              {chunkGateRows(g.fields).map((row, idx) => {
                if (row.kind === "gate") {
                  return (
                    <div
                      key={`${row.gate.path}-${idx}`}
                      className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(13rem,0.85fr)_1.35fr]"
                    >
                      {renderField(row.gate)}
                      <div className="grid h-full min-w-0 grid-cols-1 gap-2">
                        {row.knobs.map(renderField)}
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={`row-${idx}`} className={fieldGridClass(2)}>
                    {row.fields.map(renderField)}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={fieldGridClass(g.cols)}>
              {g.fields.map(renderField)}
            </div>
          )}
        </Panel>
      ))}

      {ready && pageTab === "wallet" && (
      <>
      {(() => {
        const rpcOk = secretEnv.find((r) => r.key === "RPC_URL")?.set
          || setup?.hasRpc;
        const modeLive = (safeEnv.find((r) => r.key === "FARMER_MODE")?.value ?? "").toLowerCase() === "live"
          || (setup?.farmerMode ?? "").toLowerCase() === "live";
        const howLabel =
          presence.how === "env" ? "set in .env"
            : presence.how === "unlocked" ? "encrypted + unlocked"
              : presence.how === "encrypted_locked" ? "encrypted (locked)"
                : "not set";
        return (
          <Panel title="Quick status">
            <p className="mb-3 text-[12px] text-fg">
              Two jobs here: <span className="text-ok">1)</span> wallet,{" "}
              <span className="text-ok">2)</span> RPC / API keys.
            </p>
            <ul className="space-y-2.5 text-[12px]">
              <li className="flex items-start gap-2">
                <span className={rpcOk ? "text-ok" : "text-warn"}>{rpcOk ? "✓" : "○"}</span>
                <span>
                  <span className="text-fg">RPC</span>
                  <span className="text-dim"> — {rpcOk ? "set" : "missing → add under API keys below"}</span>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className={presence.ready ? (presence.how === "encrypted_locked" ? "text-warn" : "text-ok") : "text-warn"}>
                  {presence.ready && presence.how !== "encrypted_locked" ? "✓" : "○"}
                </span>
                <span className="min-w-0">
                  <span className="text-fg">Wallet</span>
                  <span className="text-dim"> — {presence.detail}</span>
                  <span className="mt-0.5 block text-[10px] text-dim">
                    How: {howLabel}
                    {presence.envKey ? " · WALLET_PRIVATE_KEY present" : ""}
                    {presence.encrypted ? " · wallet.enc.json on disk" : ""}
                  </span>
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-dim">·</span>
                <span className="text-dim">
                  Mode looks {modeLive ? "live-capable in env" : "paper-friendly"} — switch live in Bot settings too.
                </span>
              </li>
            </ul>
          </Panel>
        );
      })()}

      <Panel
        title="1. Burner wallet"
        right={
          <Badge tone={walletBadgeTone}>
            {walletBadgeLabel}
          </Badge>
        }
      >
        {(() => {
          const readyQuiet = presence.how === "env" || presence.how === "unlocked";

          return (
            <>
              <p className="mb-3 text-[12px] leading-snug text-dim">
                {readyQuiet && !walletReplaceOpen ? (
                  <>
                    Wallet is already usable
                    {presence.how === "env" ? <> via <span className="text-fg">.env</span></> : <> (unlocked)</>}.
                    Still a <span className="text-warn">burner only</span> — never your main wallet.
                  </>
                ) : presence.how === "encrypted_locked" ? (
                  <>
                    Encrypted wallet is on disk but <span className="text-warn">locked</span>.
                    Unlock below so the bot can trade. Burner only.
                  </>
                ) : readyQuiet && walletReplaceOpen ? (
                  <>
                    Replacing will overwrite the key this host uses. Burner only — never your main wallet.
                    Pick one action:
                  </>
                ) : (
                  <>
                    This is the SOL wallet the bot uses. Use a <span className="text-warn">burner only</span> — never your main wallet.
                    Pick one action:
                  </>
                )}
              </p>
              {presence.publicKey && (
                <div className="mb-3 border border-grid bg-bg px-2 py-2">
                  <div className="text-[10px] tracking-wider text-dim uppercase">Address</div>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-ok">{presence.publicKey}</p>
                </div>
              )}

              {readyQuiet && !walletReplaceOpen ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-[11px] text-ok">No action required.</p>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 border border-grid px-2.5 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
                    onClick={() => {
                      setWalletReplaceOpen(true);
                      setWalletTab("create");
                    }}
                  >
                    <Icon icon={KeyRound} size={12} />
                    Make a new…
                  </button>
                </div>
              ) : (
                <>
                  {readyQuiet && walletReplaceOpen && (
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-[11px] text-warn">
                        Optional — only if you want to replace the current wallet.
                      </p>
                      <button
                        type="button"
                        className="shrink-0 text-[11px] tracking-wider text-dim uppercase hover:text-hover"
                        onClick={() => setWalletReplaceOpen(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <div className="mb-3 flex gap-1 border border-grid p-0.5">
                    {([
                      { id: "create" as const, label: "Make new" },
                      { id: "import" as const, label: "Import Phantom" },
                      { id: "unlock" as const, label: "Unlock" },
                    ]).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`flex-1 px-2 py-1.5 text-[10px] tracking-wider uppercase ${
                          walletTab === t.id ? "bg-ok/15 text-ok" : "text-dim hover:text-muted"
                        }`}
                        onClick={() => setWalletTab(t.id)}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <p className="mb-2 text-[11px] text-muted">
                    {walletTab === "create" && "Guided create: warnings, password, retype, then a one-time private-key backup you must confirm."}
                    {walletTab === "import" && "Guided import: same password checks, then encrypt a Phantom burner key on this host."}
                    {walletTab === "unlock" && "Type your password so the bot can use the wallet. Restart the bot after unlocking."}
                  </p>

                  {(walletTab === "create" || walletTab === "import") && (
                    <button
                      type="button"
                      className="btn-primary inline-flex items-center gap-1.5"
                      onClick={() => setWalletModal(walletTab)}
                    >
                      <Icon icon={walletTab === "create" ? KeyRound : Wallet} size={12} />
                      {walletTab === "create" ? "Start secure create…" : "Start secure import…"}
                    </button>
                  )}

                  {walletTab === "unlock" && (
                    <div className="space-y-2">
                      <label className="block space-y-1">
                        <span className="text-[11px] text-muted">Dash password (same as login token)</span>
                        <input
                          className="input-field"
                          type="password"
                          autoComplete="off"
                          value={walletConfirm}
                          onChange={(e) => setWalletConfirm(e.target.value)}
                          placeholder="DASH_TOKEN"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[11px] text-muted">Wallet password</span>
                        <input
                          className="input-field"
                          type="password"
                          autoComplete="off"
                          value={walletPass}
                          onChange={(e) => setWalletPass(e.target.value)}
                          placeholder="Passphrase you set earlier"
                        />
                      </label>
                      {secretOnce && (
                        <div className="border border-warn/50 bg-bg p-2 text-[11px] leading-snug text-warn">
                          <div className="mb-1 font-medium">Save this private key somewhere safe — shown once:</div>
                          <div className="break-all font-mono text-[10px]">{secretOnce}</div>
                        </div>
                      )}
                      <button
                        type="button"
                        className="btn-primary inline-flex items-center gap-1.5"
                        disabled={walletBusy || !walletConfirm.trim() || !walletPass}
                        onClick={() => {
                          void (async () => {
                            setWalletBusy(true);
                            setErr(null);
                            setMsg(null);
                            try {
                              const r = await unlockWallet({ confirm: walletConfirm, passphrase: walletPass });
                              setSetup(r.status);
                              setMsg(r.note ?? "Unlocked. Restart the bot if it was already running.");
                              toast({ title: "Wallet unlocked", detail: r.publicKey.slice(0, 8) + "…", tone: "ok", kind: "event" });
                              setWalletPass("");
                              setWalletReplaceOpen(false);
                            } catch (e) {
                              setErr((e as Error).message);
                              toast({ title: "Wallet action failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
                            } finally {
                              setWalletBusy(false);
                            }
                          })();
                        }}
                      >
                        <Icon icon={Unlock} size={12} />
                        {walletBusy ? "Working…" : "Unlock wallet"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}
      </Panel>

      {walletModal && (
        <WalletCreateModal
          mode={walletModal}
          overwrite={!!setup?.wallet.encrypted}
          initialDashToken={walletConfirm}
          onCancel={() => setWalletModal(null)}
          onDone={({ status, publicKey, secretOnce: once }) => {
            setSetup(status);
            setSecretOnce(once);
            setWalletModal(null);
            setWalletPass("");
            setWalletReplaceOpen(false);
            setMsg(
              once
                ? "Wallet created and backup confirmed."
                : "Wallet imported.",
            );
            toast({
              title: walletModal === "create" ? "Wallet created" : "Wallet imported",
              detail: publicKey.slice(0, 8) + "…",
              tone: "ok",
              kind: "event",
            });
          }}
        />
      )}

      <Panel
        title="2. API keys & mode"
        right={<Badge tone={secretsUnlocked ? "ok" : "warn"}>{secretsUnlocked ? "editing" : "locked"}</Badge>}
      >
        <p className="mb-3 text-[12px] leading-snug text-dim">
          Paste your RPC and optional API keys. We never show what’s already saved —
          leave a box blank to keep it. Restart the bot after big changes (RPC / wallet / live).
        </p>

        {!secretsOpen && (
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-1.5"
            onClick={() => setSecretsOpen(true)}
          >
            <Icon icon={Lock} size={12} />
            Edit keys
          </button>
        )}

        {secretsOpen && !secretsUnlocked && (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Dash password (same as login token)</span>
              <input
                className="input-field"
                type="password"
                autoComplete="off"
                value={confirmToken}
                onChange={(e) => setConfirmToken(e.target.value)}
                placeholder="DASH_TOKEN"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary inline-flex items-center gap-1.5" onClick={() => void onUnlock()}>
                <Icon icon={Unlock} size={12} />
                Unlock keys
              </button>
              <button
                type="button"
                className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
                onClick={onLock}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {secretsUnlocked && (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              {secretEnv.filter((r) => SECRET_PRIMARY.has(r.key)).map((row) => (
                <label key={row.key} className="block space-y-1">
                  <span className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                    <span>{SECRET_LABELS[row.key] ?? row.key}</span>
                    <span className={row.set ? "text-ok" : "text-warn"}>{row.set ? "saved" : "needed"}</span>
                  </span>
                  {SECRET_HELP[row.key] && (
                    <span className="block text-[10px] leading-snug text-dim">{SECRET_HELP[row.key]}</span>
                  )}
                  <input
                    className="input-field"
                    type={SECRET_IS_PASSWORD.has(row.key) ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    value={secretDraft[row.key] ?? ""}
                    placeholder={row.set ? "•••• leave blank to keep" : "paste here"}
                    onChange={(e) => setSecretDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>

            <button
              type="button"
              className="text-[11px] tracking-wider text-dim uppercase hover:text-hover"
              onClick={() => setShowAdvancedSecrets((v) => !v)}
            >
              {showAdvancedSecrets ? "Hide advanced" : "Show advanced (usually skip)"}
            </button>

            {showAdvancedSecrets && (
              <div className="grid gap-3 border border-grid p-3 md:grid-cols-2">
                {secretEnv.filter((r) => !SECRET_PRIMARY.has(r.key)).map((row) => (
                  <label key={row.key} className="block space-y-1">
                    <span className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                      <span>{SECRET_LABELS[row.key] ?? row.key}</span>
                      <span className={row.set ? "text-ok" : "text-dim"}>{row.set ? "saved" : "empty"}</span>
                    </span>
                    {SECRET_HELP[row.key] && (
                      <span className="block text-[10px] leading-snug text-dim">{SECRET_HELP[row.key]}</span>
                    )}
                    <input
                      className="input-field"
                      type={SECRET_IS_PASSWORD.has(row.key) ? "password" : "text"}
                      autoComplete="off"
                      spellCheck={false}
                      value={secretDraft[row.key] ?? ""}
                      placeholder={row.set ? "•••• leave blank to keep" : "paste here"}
                      onChange={(e) => setSecretDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-1.5"
                disabled={!secretDirty || secretsSaving}
                onClick={() => void saveSecrets()}
              >
                <Icon icon={Save} size={12} />
                {secretsSaving ? "Saving…" : secretDirty ? "Save keys" : "No changes"}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
                onClick={onLock}
              >
                <Icon icon={Lock} size={12} />
                Done / lock
              </button>
            </div>
          </div>
        )}
      </Panel>
      </>
      )}
    </div>
  );
}
