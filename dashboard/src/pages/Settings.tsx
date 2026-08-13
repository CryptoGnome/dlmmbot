import { useEffect, useMemo, useState } from "react";
import { fetchConfig, fetchEnv, patchConfig, type EnvRow, type FlatConfig } from "@/lib/api";
import { Badge, Panel } from "@/components/ui";

function coerce(raw: string, sample: unknown): unknown {
  if (typeof sample === "boolean") return raw === "true" || raw === "1";
  if (typeof sample === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${raw}`);
    return n;
  }
  if (Array.isArray(sample)) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("expected JSON array");
      return parsed;
    } catch {
      return raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return raw;
}

export function SettingsPage() {
  const [config, setConfig] = useState<FlatConfig | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [c, e] = await Promise.all([fetchConfig(), fetchEnv()]);
      setConfig(c);
      const d: Record<string, string> = {};
      for (const [k, v] of Object.entries(c)) {
        d[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
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

  const sections = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const key of Object.keys(draft).sort()) {
      const sec = key.split(".")[0]!;
      if (!map.has(sec)) map.set(sec, []);
      map.get(sec)!.push(key);
    }
    return [...map.entries()];
  }, [draft]);

  const dirty = useMemo(() => {
    if (!config) return {} as Record<string, unknown>;
    const updates: Record<string, unknown> = {};
    for (const [path, raw] of Object.entries(draft)) {
      const sample = config[path];
      const orig = Array.isArray(sample) ? JSON.stringify(sample) : String(sample);
      if (raw === orig) continue;
      try {
        updates[path] = coerce(raw, sample);
      } catch {
        /* validated on save */
      }
    }
    return updates;
  }, [config, draft]);

  const dirtyCount = Object.keys(dirty).length;

  const save = async () => {
    if (!config || !dirtyCount) return;
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const updates: Record<string, unknown> = {};
      for (const [path, raw] of Object.entries(draft)) {
        const sample = config[path];
        const orig = Array.isArray(sample) ? JSON.stringify(sample) : String(sample);
        if (raw === orig) continue;
        updates[path] = coerce(raw, sample);
      }
      const result = await patchConfig(updates);
      setConfig(result.config);
      const d: Record<string, string> = {};
      for (const [k, v] of Object.entries(result.config)) {
        d[k] = Array.isArray(v) ? JSON.stringify(v) : String(v);
      }
      setDraft(d);
      setMsg(`Saved ${result.applied.length} key(s). Farmer hot-reloads within ~2s.`);
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-wide">Settings</h1>
          <p className="text-[11px] text-dim">
            Edits write config.toml in place (comments kept). Env is read-only and masked.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className="btn-primary" disabled={!dirtyCount || saving} onClick={() => void save()}>
            {saving ? "Saving…" : dirtyCount ? `Save ${dirtyCount}` : "Saved"}
          </button>
          <button
            type="button"
            className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
            onClick={() => void load()}
            disabled={loading}
          >
            Reload
          </button>
        </div>
      </div>

      {err && <div className="border border-danger/60 bg-panel px-3 py-2 text-danger text-[11px]">{err}</div>}
      {msg && <div className="border border-ok/60 bg-panel px-3 py-2 text-ok text-[11px]">{msg}</div>}
      {loading && <div className="text-[12px] text-dim">Loading config…</div>}

      {!loading && sections.map(([sec, keys]) => (
        <Panel key={sec} title={`[${sec}]`} right={<Badge tone="accent">{keys.length}</Badge>}>
          <div className="grid gap-2 md:grid-cols-2">
            {keys.map((path) => {
              const key = path.slice(path.indexOf(".") + 1);
              const changed = config
                ? draft[path] !== (Array.isArray(config[path]) ? JSON.stringify(config[path]) : String(config[path]))
                : false;
              const sample = config?.[path];
              const isBool = typeof sample === "boolean";
              return (
                <label key={path} className="block space-y-1">
                  <span className={`text-[10px] tracking-wider ${changed ? "text-hover" : "text-dim"}`}>
                    {key}{changed ? " *" : ""}
                  </span>
                  {isBool ? (
                    <select
                      className="input-field"
                      value={draft[path] ?? "false"}
                      onChange={(e) => setDraft((d) => ({ ...d, [path]: e.target.value }))}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="input-field"
                      value={draft[path] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [path]: e.target.value }))}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </Panel>
      ))}

      <Panel title="Environment (masked)" right={<Badge tone="warn">read-only</Badge>}>
        <table className="w-full text-left text-[12px]">
          <thead className="text-dim">
            <tr>
              <th className="pb-1.5 pr-2 font-normal">Key</th>
              <th className="pb-1.5 pr-2 font-normal">Set</th>
              <th className="pb-1.5 font-normal">Value</th>
            </tr>
          </thead>
          <tbody>
            {env.map((row) => (
              <tr key={row.key} className="border-t border-grid">
                <td className="py-1.5 pr-2 text-muted">{row.key}</td>
                <td className="py-1.5 pr-2">
                  <span className={row.set ? "text-ok" : "text-dim"}>{row.set ? "yes" : "no"}</span>
                  {row.secret && row.set && <span className="ml-1 text-[10px] text-dim">secret</span>}
                </td>
                <td className="py-1.5 font-mono text-[11px] text-fg">{row.value ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
