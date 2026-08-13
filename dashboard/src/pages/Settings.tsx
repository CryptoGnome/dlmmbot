import { useEffect, useMemo, useState } from "react";
import {
  fetchConfig, fetchEnv, patchConfig, patchSecrets, unlockSecrets,
  type EnvRow, type FlatConfig,
} from "@/lib/api";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { Settings as SettingsIcon, Save, RefreshCw, Lock, Unlock } from "lucide-react";

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
    ],
  },
  {
    title: "Entry filters",
    blurb: "Skip pools that don’t clear these floors.",
    fields: [
      { path: "gates.mcap_min_usd", label: "Min market cap", kind: "usd", min: 50_000, max: 500_000, step: 10_000 },
      { path: "gates.tvl_min_usd", label: "Min pool TVL", kind: "usd", min: 1_000, max: 50_000, step: 1_000 },
      { path: "gates.vol_30m_min_usd", label: "Min 30m volume", kind: "usd", min: 5_000, max: 100_000, step: 5_000 },
      {
        path: "gates.fee_tvl_24h_min_pct",
        label: "Min fee / TVL",
        kind: "pct",
        scale: "pct",
        min: 5,
        max: 50,
        step: 1,
        hint: (ui) => `${ui}% per day`,
      },
      { path: "entry.tranche_enabled", label: "Second tranche", kind: "bool", help: "Extra BidAsk pocket under high-score primaries." },
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
    title: "Follow & mode",
    fields: [
      { path: "follow.enabled", label: "Follow re-entry", kind: "bool", help: "Small legs after a clean above-range exit." },
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

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [c, e] = await Promise.all([fetchConfig(), fetchEnv()]);
      setConfig(c);
      const d: Record<string, string> = {};
      for (const path of PUBLIC_PATHS) {
        if (path in c) d[path] = wireStr(c[path]);
      }
      setDraft(d);
      setEnv(e);
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
    } catch (e) {
      setSecretsUnlocked(false);
      setErr((e as Error).message ?? String(e));
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
    } catch (e) {
      setErr((e as Error).message ?? String(e));
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
      setMsg(`Saved ${result.applied.length} setting(s). Farmer hot-reloads within ~2s.`);
    } catch (e) {
      setErr((e as Error).message ?? String(e));
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display flex items-center gap-2 text-lg font-semibold tracking-wide">
            <Icon icon={SettingsIcon} size={18} className="text-accent" />
            Settings
          </h1>
          <p className="text-[11px] text-dim">
            Sliders & percentages — advanced knobs stay in config.toml.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!dirtyCount || saving} onClick={() => void save()}>
            <Icon icon={Save} size={12} />
            {saving ? "Saving…" : dirtyCount ? `Save ${dirtyCount}` : "Saved"}
          </button>
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

      {err && <div className="border border-danger/60 bg-panel px-3 py-2 text-danger text-[11px]">{err}</div>}
      {msg && <div className="border border-ok/60 bg-panel px-3 py-2 text-ok text-[11px]">{msg}</div>}
      {loading && <div className="text-[12px] text-dim">Loading…</div>}

      {!loading && GROUPS.map((g) => (
        <Panel key={g.title} title={g.title} right={<Badge tone="accent">{g.fields.filter((f) => f.path in (config ?? {})).length}</Badge>}>
          {g.blurb && <p className="mb-3 text-[11px] text-dim">{g.blurb}</p>}
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            {g.fields.map(renderField)}
          </div>
        </Panel>
      ))}

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
        title="Secrets vault"
        right={<Badge tone="warn">{secretsUnlocked ? "unlocked" : "locked"}</Badge>}
      >
        <p className="mb-3 text-[11px] leading-snug text-dim">
          Re-enter your dash token to edit RPC / wallet / API keys. Values are never shown —
          leave a field blank to keep what is already on the box. Farmer restart needed after wallet/RPC changes.
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
    </div>
  );
}
