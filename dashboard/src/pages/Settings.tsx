import { useEffect, useMemo, useState } from "react";
import {
  fetchConfig, fetchEnv, fetchSetupStatus, generateWallet, importWallet,
  patchConfig, patchSecrets, unlockSecrets, unlockWallet,
  type EnvRow, type FlatConfig, type SetupStatus,
} from "@/lib/api";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { toast } from "@/lib/toast";
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

type Group = { title: string; blurb?: string; fields: Field[] };

const GROUPS: Group[] = [
  {
    title: "Book & size",
    blurb: "How many positions and how big they can get.",
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
      {
        path: "exec.escape_rebalance_enabled",
        label: "Escape rebalance",
        kind: "bool",
        help: "Try reshape-in-place before closing on escape hatch. Off = close instead.",
      },
    ],
  },
  {
    title: "Pool filters",
    blurb: "Skip pools that don’t clear these floors (before token vetting).",
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
    blurb: "Toggle a check off to stop blocking on it, or leave it on and set how strict the slider is.",
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
      { path: "profit_burn.enabled", label: "Profit burn", kind: "bool", help: "Spend a cut of measured net profit to buy+burn a mint." },
    ],
  },
  {
    title: "Majors parking",
    blurb: "Separate sleeve for SOL-quoted majors (ANSEM, PUMP, …).",
    fields: [
      { path: "majors.enabled", label: "Enabled", kind: "bool" },
      { path: "majors.size_sol", label: "Position size", kind: "sol", min: 0.25, max: 3, step: 0.25 },
      { path: "majors.max_slots", label: "Max majors slots", kind: "int", min: 0, max: 3 },
      { path: "majors.symbol_allowlist", label: "Allowlist", kind: "text", help: "Comma-separated, e.g. PUMP, ANSEM, JUP." },
    ],
  },
  {
    title: "Mode",
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

const PUBLIC_PATHS = new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.path)));

const SECRET_LABELS: Record<string, string> = {
  RPC_URL: "Primary RPC",
  RPC_URL_FALLBACK: "Fallback RPC",
  WALLET_PUBKEY: "Wallet pubkey",
  PUBLIC_WALLET: "Public wallet",
  WALLET_PRIVATE_KEY: "Wallet private key",
  WALLET_KEYPAIR_PATH: "Keypair path",
  JUPITER_API_KEY: "Jupiter API key",
  GMGN_API_KEY: "GMGN API key",
  TELEGRAM_BOT_TOKEN: "Telegram bot token",
  TELEGRAM_CHAT_ID: "Telegram chat id",
  FARMER_MODE: "Bot mode",
};

const SECRET_IS_PASSWORD = new Set([
  "WALLET_PRIVATE_KEY",
  "JUPITER_API_KEY",
  "GMGN_API_KEY",
  "TELEGRAM_BOT_TOKEN",
]);

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
    <div className="block max-w-[13.5rem] space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11px] ${changed ? "text-hover" : "text-muted"}`} title={help}>
          {label}{changed ? " *" : ""}
        </span>
        <span className="font-mono text-[11px] text-fg tabular-nums">{display}</span>
      </div>
      {hint && <p className="text-[9px] leading-snug text-accent">{hint}</p>}
      <input
        type="range"
        className="slider-field"
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

export function SettingsPage() {
  const [config, setConfig] = useState<FlatConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [secretsOpen, setSecretsOpen] = useState(false);
  const [secretsUnlocked, setSecretsUnlocked] = useState(false);
  const [confirmToken, setConfirmToken] = useState("");
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [secretsSaving, setSecretsSaving] = useState(false);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [walletTab, setWalletTab] = useState<"create" | "import" | "unlock">("create");
  const [walletConfirm, setWalletConfirm] = useState("");
  const [walletPass, setWalletPass] = useState("");
  const [walletPass2, setWalletPass2] = useState("");
  const [walletSecret, setWalletSecret] = useState("");
  const [walletBusy, setWalletBusy] = useState(false);
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [pageTab, setPageTab] = useState<"bot" | "wallet">("bot");

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [c, e, s] = await Promise.all([fetchConfig(), fetchEnv(), fetchSetupStatus()]);
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
        <div key={f.path} className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className={`text-[11px] ${changed ? "text-hover" : "text-muted"}`}>
              {f.label}{changed ? " *" : ""}
            </div>
            {f.help && <p className="mt-1 text-[10px] leading-snug text-dim">{f.help}</p>}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            className={`shrink-0 border px-3 py-1 text-[11px] tracking-wider uppercase ${
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
        <label key={f.path} className="block space-y-1">
          <span className={`text-[11px] ${changed ? "text-hover" : "text-muted"}`}>
            {f.label}{changed ? " *" : ""}
          </span>
          {f.help && <span className="block text-[10px] leading-snug text-dim">{f.help}</span>}
          <select className="input-field" value={wire} onChange={(e) => setPath(f.path, e.target.value)}>
            {f.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      );
    }

    if (f.kind === "text") {
      return (
        <label key={f.path} className="block w-full max-w-md space-y-1 basis-full">
          <span className={`text-[11px] ${changed ? "text-hover" : "text-muted"}`}>
            {f.label}{changed ? " *" : ""}
          </span>
          {f.help && <span className="block text-[10px] leading-snug text-dim">{f.help}</span>}
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

  const walletBadgeTone = setup?.wallet.unlocked ? "ok" : setup?.wallet.encrypted ? "warn" : "fg";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={pageTab === "bot" ? SettingsIcon : Wallet} size={18} className="text-accent" />
            Settings
          </h1>
          <p className="text-[11px] text-dim">
            {pageTab === "bot"
              ? "Bot knobs — advanced keys stay in config.toml."
              : "Encrypted wallet and secrets vault — kept off the bot knobs page."}
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
            className="inline-flex items-center gap-1.5 border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
            onClick={() => void load()}
            disabled={loading}
          >
            <Icon icon={RefreshCw} size={12} />
            Reload
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
        >
          <Icon icon={Wallet} size={12} />
          Wallet & secrets
          <Badge tone={walletBadgeTone}>
            {setup?.wallet.unlocked ? "unlocked" : setup?.wallet.encrypted ? "locked" : "none"}
          </Badge>
        </button>
      </div>

      {err && <div className="border border-danger/60 bg-panel px-3 py-2 text-danger text-[11px]">{err}</div>}
      {msg && <div className="border border-ok/60 bg-panel px-3 py-2 text-ok text-[11px]">{msg}</div>}
      {loading && <div className="text-[12px] text-dim">Loading…</div>}

      {!loading && pageTab === "bot" && GROUPS.map((g) => (
        <Panel key={g.title} title={g.title} right={<Badge tone="accent">{g.fields.filter((f) => f.path in (config ?? {})).length}</Badge>}>
          {g.blurb && <p className="mb-3 text-[11px] text-dim">{g.blurb}</p>}
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            {g.fields.map(renderField)}
          </div>
        </Panel>
      ))}

      {!loading && pageTab === "wallet" && (
      <>
      <Panel title="Runtime" right={<Badge tone="ok">safe</Badge>}>
        <p className="mb-2 text-[11px] text-dim">
          Non-secret process status only. RPC, wallet, and keys never appear here.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {safeEnv.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-2 border border-grid px-2 py-1.5 text-[12px]">
              <span className="text-muted">{row.key}</span>
              <span className={`font-mono text-[11px] ${row.set ? "text-fg" : "text-dim"}`}>
                {row.value ?? "—"}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {secretEnv.map((row) => (
            <span
              key={row.key}
              className={`border px-2 py-1 text-[10px] tracking-wider uppercase ${
                row.set ? "border-ok/40 text-ok" : "border-grid text-dim"
              }`}
              title={row.key}
            >
              {SECRET_LABELS[row.key] ?? row.key} · {row.set ? "set" : "missing"}
            </span>
          ))}
        </div>
      </Panel>

      <Panel
        title="Encrypted wallet"
        right={
          <Badge tone={walletBadgeTone}>
            {setup?.wallet.unlocked ? "unlocked" : setup?.wallet.encrypted ? "locked" : "none"}
          </Badge>
        }
      >
        <p className="mb-3 text-[11px] leading-snug text-dim">
          Create a new keypair or import Phantom. Encrypted at rest with your passphrase.
          Unlock writes the key into .env for live mode — restart the bot after unlock
          (or set WALLET_PASSPHRASE on Railway to auto-unlock on boot).
        </p>
        {setup?.wallet.publicKey && (
          <p className="mb-3 font-mono text-[11px] text-ok">
            {setup.wallet.publicKey}
          </p>
        )}
        <div className="mb-3 flex gap-1 border border-grid p-0.5">
          {(["create", "import", "unlock"] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`flex-1 px-2 py-1.5 text-[10px] tracking-wider uppercase ${
                walletTab === t ? "bg-ok/15 text-ok" : "text-dim hover:text-muted"
              }`}
              onClick={() => setWalletTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-[11px] text-muted">Confirm dash token</span>
            <input
              className="input-field"
              type="password"
              autoComplete="off"
              value={walletConfirm}
              onChange={(e) => setWalletConfirm(e.target.value)}
            />
          </label>
          {walletTab === "import" && (
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Phantom private key</span>
              <input
                className="input-field"
                type="password"
                autoComplete="off"
                value={walletSecret}
                onChange={(e) => setWalletSecret(e.target.value)}
              />
            </label>
          )}
          <label className="block space-y-1">
            <span className="text-[11px] text-muted">
              {walletTab === "unlock" ? "Passphrase" : "Encrypt passphrase"}
            </span>
            <input
              className="input-field"
              type="password"
              autoComplete="off"
              value={walletPass}
              onChange={(e) => setWalletPass(e.target.value)}
            />
          </label>
          {walletTab !== "unlock" && (
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Confirm passphrase</span>
              <input
                className="input-field"
                type="password"
                autoComplete="off"
                value={walletPass2}
                onChange={(e) => setWalletPass2(e.target.value)}
              />
            </label>
          )}
          {secretOnce && (
            <div className="border border-warn/50 bg-bg p-2 text-[10px] break-all text-warn">
              Backup once: {secretOnce}
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
                  if (walletTab === "unlock") {
                    const r = await unlockWallet({ confirm: walletConfirm, passphrase: walletPass });
                    setSetup(r.status);
                    setMsg(r.note ?? "Unlocked.");
                    toast({ title: "Wallet unlocked", detail: r.publicKey.slice(0, 8) + "…", tone: "ok", kind: "event" });
                    setWalletPass("");
                  } else {
                    if (walletPass !== walletPass2) throw new Error("passphrases do not match");
                    if (walletTab === "create") {
                      const r = await generateWallet({
                        confirm: walletConfirm,
                        passphrase: walletPass,
                        overwrite: !!setup?.wallet.encrypted,
                      });
                      setSecretOnce(r.secretOnce);
                      setSetup(r.status);
                      setMsg(r.note ?? "Created.");
                      toast({ title: "Wallet created", detail: r.publicKey.slice(0, 8) + "…", tone: "ok", kind: "event" });
                    } else {
                      const r = await importWallet({
                        confirm: walletConfirm,
                        passphrase: walletPass,
                        secret: walletSecret,
                        overwrite: !!setup?.wallet.encrypted,
                      });
                      setSetup(r.status);
                      setWalletSecret("");
                      setMsg(r.note ?? "Imported.");
                      toast({ title: "Wallet imported", detail: r.publicKey.slice(0, 8) + "…", tone: "ok", kind: "event" });
                    }
                    setWalletPass("");
                    setWalletPass2("");
                  }
                } catch (e) {
                  setErr((e as Error).message);
                  toast({ title: "Wallet action failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
                } finally {
                  setWalletBusy(false);
                }
              })();
            }}
          >
            <Icon icon={walletTab === "unlock" ? Unlock : walletTab === "create" ? KeyRound : Wallet} size={12} />
            {walletBusy ? "Working…" : walletTab === "unlock" ? "Unlock" : walletTab === "create" ? "Create" : "Import"}
          </button>
        </div>
      </Panel>

      <Panel
        title="Secrets vault"
        right={<Badge tone="warn">{secretsUnlocked ? "unlocked" : "locked"}</Badge>}
      >
        <p className="mb-3 text-[11px] leading-snug text-dim">
          Re-enter your dash token to edit RPC / wallet / API keys. Values are never shown —
          leave a field blank to keep what is already on the box. Bot restart needed after wallet/RPC changes.
        </p>

        {!secretsOpen && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
            onClick={() => setSecretsOpen(true)}
          >
            <Icon icon={Lock} size={12} />
            Edit secrets…
          </button>
        )}

        {secretsOpen && !secretsUnlocked && (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Confirm dash token</span>
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
                Unlock
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
              {secretEnv.map((row) => (
                <label key={row.key} className="block space-y-1">
                  <span className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                    <span>{SECRET_LABELS[row.key] ?? row.key}</span>
                    <span className={row.set ? "text-ok" : "text-dim"}>{row.set ? "set" : "empty"}</span>
                  </span>
                  <input
                    className="input-field"
                    type={SECRET_IS_PASSWORD.has(row.key) ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    value={secretDraft[row.key] ?? ""}
                    placeholder={row.set ? "•••• leave blank to keep" : "paste new value"}
                    onChange={(e) => setSecretDraft((d) => ({ ...d, [row.key]: e.target.value }))}
                  />
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-1.5"
                disabled={!secretDirty || secretsSaving}
                onClick={() => void saveSecrets()}
              >
                <Icon icon={Save} size={12} />
                {secretsSaving ? "Writing…" : secretDirty ? "Write secrets" : "No changes"}
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
                onClick={onLock}
              >
                <Icon icon={Lock} size={12} />
                Lock
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
