import { useCallback, useEffect, useState } from "react";
import {
  applyProfileApi,
  deleteLocalProfileApi,
  fetchCommunityProfiles,
  fetchProfiles,
  fetchProfileSnapshot,
  previewProfileApi,
  saveLocalProfileApi,
  type FlatConfig,
  type ProfileShareMeta,
  type SettingsProfile,
} from "@/lib/api";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { toast } from "@/lib/toast";
import {
  Check, Download, ExternalLink, Layers, Trash2, Upload,
} from "lucide-react";

type PreviewState = {
  source: string;
  id: string;
  name: string;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
  updates: Record<string, unknown>;
};

function fmtVal(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function ProfileCard({
  p, onPreview, onDelete, busy,
}: {
  p: SettingsProfile & { source?: string };
  onPreview: () => void;
  onDelete?: () => void;
  busy: boolean;
}) {
  return (
    <div className="min-w-[11rem] flex-1 border border-grid p-3">
      <div className="flex flex-wrap items-start gap-1.5">
        <div className="font-display text-[13px] font-semibold text-fg">{p.name}</div>
        {(p.tags ?? []).slice(0, 2).map((t) => (
          <Badge key={t} tone={t.includes("risk-on") ? "warn" : t.includes("risk-off") ? "ok" : "accent"}>
            {t}
          </Badge>
        ))}
      </div>
      <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-dim">
        {p.description || "No description."}
      </p>
      <div className="mt-2 text-[10px] text-muted">
        {p.author ? `${p.author}` : ""}{p.updated ? ` · ${p.updated}` : ""}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={busy}
          className="inline-flex items-center gap-1 border border-ok/50 px-2 py-1 text-[10px] tracking-wider text-ok uppercase hover:border-hover hover:text-hover disabled:opacity-40"
          onClick={onPreview}
        >
          <Icon icon={Check} size={10} />
          Preview
        </button>
        {onDelete && (
          <button
            type="button"
            disabled={busy}
            className="inline-flex items-center gap-1 border border-grid px-2 py-1 text-[10px] tracking-wider text-dim uppercase hover:border-danger/50 hover:text-danger disabled:opacity-40"
            onClick={onDelete}
          >
            <Icon icon={Trash2} size={10} />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

export function ProfilesPanel({
  onApplied,
}: {
  onApplied: (config: FlatConfig) => void;
}) {
  const [official, setOfficial] = useState<SettingsProfile[]>([]);
  const [local, setLocal] = useState<SettingsProfile[]>([]);
  const [community, setCommunity] = useState<Array<{
    id: string; name: string; author?: string; description?: string;
    tags?: string[]; updated?: string;
  }>>([]);
  const [share, setShare] = useState<ProfileShareMeta | null>(null);
  const [communityErr, setCommunityErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [saveName, setSaveName] = useState("");
  const [q, setQ] = useState("");

  const reload = useCallback(async () => {
    const [p, c] = await Promise.all([
      fetchProfiles(),
      fetchCommunityProfiles().catch((e) => ({
        profiles: [] as typeof community,
        error: (e as Error).message,
        share: null as ProfileShareMeta | null,
      })),
    ]);
    setOfficial(p.official);
    setLocal(p.local);
    setShare(p.share);
    setCommunity(c.profiles);
    setCommunityErr(c.error);
    if (c.share) setShare(c.share);
  }, []);

  useEffect(() => {
    void reload().catch((e) => {
      toast({ title: "Profiles load failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    });
  }, [reload]);

  async function openPreview(source: string, id: string, name: string) {
    setBusy(true);
    try {
      const r = await previewProfileApi({ source, id });
      setPreview({
        source,
        id,
        name,
        changes: r.changes,
        updates: r.updates,
      });
    } catch (e) {
      toast({ title: "Preview failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    } finally {
      setBusy(false);
    }
  }

  async function confirmApply() {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await applyProfileApi({ source: preview.source, id: preview.id });
      onApplied(r.config);
      setPreview(null);
      toast({
        title: `Applied ${preview.name}`,
        detail: `${r.applied.length} setting(s)`,
        tone: "ok",
        kind: "event",
      });
      await reload();
    } catch (e) {
      toast({ title: "Apply failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    } finally {
      setBusy(false);
    }
  }

  async function saveLocal() {
    if (!saveName.trim()) return;
    setBusy(true);
    try {
      await saveLocalProfileApi({ name: saveName.trim() });
      setSaveName("");
      toast({ title: "Profile saved", detail: saveName.trim(), tone: "ok", kind: "event" });
      await reload();
    } catch (e) {
      toast({ title: "Save failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    } finally {
      setBusy(false);
    }
  }

  async function shareCurrent() {
    setBusy(true);
    try {
      const snap = await fetchProfileSnapshot();
      const blob = {
        schema: 1,
        id: "my-profile",
        name: saveName.trim() || "My profile",
        description: "Exported from DLMM Bot Settings.",
        author: "operator",
        tags: ["community"],
        updated: new Date().toISOString().slice(0, 10),
        updates: snap.updates,
      };
      const text = JSON.stringify(blob, null, 2) + "\n";
      try {
        await navigator.clipboard.writeText(text);
        toast({ title: "Profile JSON copied", tone: "ok", kind: "event" });
      } catch {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        a.download = "dlmmbot-profile.json";
        a.click();
        toast({ title: "Profile downloaded", tone: "ok", kind: "event" });
      }
      const url = snap.share_url || share?.new_file_base;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast({ title: "Share failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    } finally {
      setBusy(false);
    }
  }

  const filteredCommunity = community.filter((p) => {
    if (!q.trim()) return true;
    const hay = `${p.name} ${p.author ?? ""} ${p.description ?? ""} ${(p.tags ?? []).join(" ")}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  return (
    <>
      <Panel
        title="Profiles"
        right={<Badge tone="accent"><Icon icon={Layers} size={10} className="mr-1 inline" />presets</Badge>}
      >
        <p className="mb-3 text-[11px] text-dim">
          Official packs, your saved snapshots, and community profiles from GitHub.
          Applying never changes paper/live mode or secrets.
        </p>

        <div className="mb-4">
          <div className="mb-1.5 text-[10px] tracking-[0.14em] text-dim uppercase">Official</div>
          <div className="flex flex-wrap gap-2">
            {official.map((p) => (
              <ProfileCard
                key={p.id}
                p={{ ...p, source: "official" }}
                busy={busy}
                onPreview={() => void openPreview("official", p.id, p.name)}
              />
            ))}
            {!official.length && <div className="text-[11px] text-dim">No official presets on disk.</div>}
          </div>
        </div>

        <div className="mb-4 border-t border-grid pt-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[10px] tracking-[0.14em] text-dim uppercase">My profiles</span>
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Name this config…"
              className="min-w-[10rem] flex-1 border border-grid bg-transparent px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={busy || !saveName.trim()}
              className="inline-flex items-center gap-1 border border-grid px-2 py-1 text-[10px] tracking-wider text-muted uppercase hover:text-hover disabled:opacity-40"
              onClick={() => void saveLocal()}
            >
              <Icon icon={Upload} size={10} />
              Save current
            </button>
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-1 border border-accent/40 px-2 py-1 text-[10px] tracking-wider text-accent uppercase hover:text-hover disabled:opacity-40"
              onClick={() => void shareCurrent()}
              title="Copy JSON and open GitHub new-file for community PR"
            >
              <Icon icon={Download} size={10} />
              Share
              <Icon icon={ExternalLink} size={9} className="opacity-60" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {local.map((p) => (
              <ProfileCard
                key={p.id}
                p={{ ...p, source: "local" }}
                busy={busy}
                onPreview={() => void openPreview("local", p.id, p.name)}
                onDelete={() => {
                  void (async () => {
                    setBusy(true);
                    try {
                      await deleteLocalProfileApi(p.id);
                      toast({ title: "Deleted", detail: p.name, tone: "ok", kind: "event" });
                      await reload();
                    } catch (e) {
                      toast({ title: "Delete failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              />
            ))}
            {!local.length && <div className="text-[11px] text-dim">No local saves yet.</div>}
          </div>
        </div>

        <div className="border-t border-grid pt-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="text-[10px] tracking-[0.14em] text-dim uppercase">Community</span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="min-w-[8rem] border border-grid bg-transparent px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
            />
            {share?.community_readme && (
              <a
                href={share.community_readme}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[10px] tracking-wider text-accent no-underline uppercase hover:text-hover"
              >
                How to PR
                <Icon icon={ExternalLink} size={9} />
              </a>
            )}
          </div>
          {communityErr && (
            <p className="mb-2 text-[11px] text-warn">Gallery offline: {communityErr}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {filteredCommunity.map((p) => (
              <ProfileCard
                key={p.id}
                p={{ schema: 1, ...p, source: "community" }}
                busy={busy}
                onPreview={() => void openPreview("community", p.id, p.name)}
              />
            ))}
            {!filteredCommunity.length && (
              <div className="text-[11px] text-dim">
                {community.length ? "No matches." : "No community profiles yet — be the first to Share."}
              </div>
            )}
          </div>
        </div>
      </Panel>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center">
          <div className="max-h-[85dvh] w-full max-w-lg overflow-auto border border-grid bg-panel p-4 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-fg">Apply {preview.name}?</h2>
                <p className="mt-1 text-[11px] text-dim">
                  {preview.changes.length
                    ? `${preview.changes.length} setting(s) will change. Paper/live mode is never touched.`
                    : "Already matches — nothing to change."}
                </p>
              </div>
              <button
                type="button"
                className="text-[11px] text-dim hover:text-fg"
                onClick={() => setPreview(null)}
              >
                Close
              </button>
            </div>
            {!!preview.changes.length && (
              <ul className="mt-3 max-h-64 space-y-1 overflow-auto border border-grid p-2 text-[11px]">
                {preview.changes.map((c) => (
                  <li key={c.path} className="grid grid-cols-[1fr_auto] gap-2 border-b border-grid/60 py-1 last:border-0">
                    <span className="font-mono text-muted">{c.path}</span>
                    <span className="tabular-nums text-fg">
                      <span className="text-dim">{fmtVal(c.from)}</span>
                      {" → "}
                      <span className="text-ok">{fmtVal(c.to)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-fg"
                onClick={() => setPreview(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !preview.changes.length}
                className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-40"
                onClick={() => void confirmApply()}
              >
                <Icon icon={Check} size={12} />
                {busy ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
