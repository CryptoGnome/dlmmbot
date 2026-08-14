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
import { copyText } from "@/lib/errorReport";
import {
  Check, Copy, Download, ExternalLink, Layers, Trash2, Upload,
} from "lucide-react";

type PreviewState = {
  source: string;
  id: string;
  name: string;
  changes: Array<{ path: string; from: unknown; to: unknown }>;
  updates: Record<string, unknown>;
};

type ShareState = {
  json: string;
  indexRow: string;
  slug: string;
  name: string;
  share: ProfileShareMeta;
  createUrl: string;
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
  const [shareGuide, setShareGuide] = useState<ShareState | null>(null);
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

  async function openShareGuide() {
    setBusy(true);
    try {
      const name = saveName.trim() || "My profile";
      const snap = await fetchProfileSnapshot(name);
      const meta = snap.share ?? share;
      const blob = {
        schema: 1,
        id: snap.slug,
        name,
        description: "Exported from DLMM Bot Settings. Edit before opening a PR.",
        author: "operator",
        tags: ["community"],
        updated: new Date().toISOString().slice(0, 10),
        updates: snap.updates,
      };
      const json = `${JSON.stringify(blob, null, 2)}\n`;
      const indexRow = JSON.stringify({
        id: snap.slug,
        name,
        author: "operator",
        description: blob.description,
        tags: ["community"],
        file: `${snap.slug}.json`,
        updated: blob.updated,
      }, null, 2);
      setShareGuide({
        json,
        indexRow,
        slug: snap.slug,
        name,
        share: meta ?? {
          repo: "CryptoGnome/dlmmbot",
          ref: "master",
          new_file_base: "",
          community_readme: "",
        },
        createUrl: snap.share_url || `${meta?.new_file_base ?? ""}${snap.slug}.json`,
      });
    } catch (e) {
      toast({ title: "Share failed", detail: (e as Error).message, tone: "danger", kind: "fail" });
    } finally {
      setBusy(false);
    }
  }

  async function copyBlob(text: string, label: string) {
    const ok = await copyText(text);
    if (ok) {
      toast({ title: `${label} copied`, tone: "ok", kind: "event" });
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = label.includes("index") ? "index-row.json" : "dlmmbot-profile.json";
    a.click();
    toast({ title: `${label} downloaded`, detail: "Clipboard blocked — file saved instead", tone: "ok", kind: "event" });
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
          Applying never changes paper/live mode or secrets. Sharing is browser-only — works from Railway.
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
              onClick={() => void openShareGuide()}
              title="Guided share → GitHub PR (fork in browser if needed)"
            >
              <Icon icon={Download} size={10} />
              Share to GitHub
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
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-1 text-[10px] tracking-wider text-accent uppercase hover:text-hover disabled:opacity-40"
              onClick={() => void openShareGuide()}
            >
              How to contribute
            </button>
            {share?.community_readme && (
              <a
                href={share.community_readme}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[10px] tracking-wider text-muted no-underline uppercase hover:text-hover"
              >
                README
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
                {community.length ? "No matches." : "No community profiles yet — use Share to GitHub."}
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

      {shareGuide && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center">
          <div className="max-h-[90dvh] w-full max-w-xl overflow-auto border border-grid bg-panel p-4 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-fg">Share “{shareGuide.name}”</h2>
                <p className="mt-1 text-[11px] leading-snug text-dim">
                  {shareGuide.share.fork_hint
                    ?? "Use github.com in the browser. Fork if GitHub asks — no git needed on Railway."}
                </p>
              </div>
              <button
                type="button"
                className="text-[11px] text-dim hover:text-fg"
                onClick={() => setShareGuide(null)}
              >
                Close
              </button>
            </div>

            <ol className="mt-3 space-y-3 text-[12px] text-fg">
              <li className="border border-grid p-2.5">
                <div className="mb-1 text-[10px] tracking-wider text-dim uppercase">1 · Copy profile JSON</div>
                <p className="mb-2 text-[11px] text-muted">
                  File will be <span className="font-mono text-fg">profiles/community/{shareGuide.slug}.json</span>
                </p>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 border border-accent/50 px-2 py-1 text-[10px] tracking-wider text-accent uppercase hover:text-hover"
                  onClick={() => void copyBlob(shareGuide.json, "Profile JSON")}
                >
                  <Icon icon={Copy} size={10} />
                  Copy JSON
                </button>
              </li>
              <li className="border border-grid p-2.5">
                <div className="mb-1 text-[10px] tracking-wider text-dim uppercase">2 · Copy index row</div>
                <p className="mb-2 text-[11px] text-muted">
                  Paste this object into the <span className="font-mono text-fg">profiles</span> array in{" "}
                  <span className="font-mono text-fg">index.json</span> (same PR).
                </p>
                <pre className="mb-2 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-dim">
                  {shareGuide.indexRow}
                </pre>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 border border-accent/50 px-2 py-1 text-[10px] tracking-wider text-accent uppercase hover:text-hover"
                  onClick={() => void copyBlob(shareGuide.indexRow, "Index row")}
                >
                  <Icon icon={Copy} size={10} />
                  Copy index row
                </button>
              </li>
              <li className="border border-grid p-2.5">
                <div className="mb-1 text-[10px] tracking-wider text-dim uppercase">3 · Open GitHub (fork if asked)</div>
                <p className="mb-2 text-[11px] text-muted">
                  Logged into GitHub? Click create file. If you cannot push to{" "}
                  <span className="font-mono text-fg">{shareGuide.share.repo}</span>, choose{" "}
                  <span className="text-fg">Fork this repository</span>, then commit on your fork and open a PR.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <a
                    href={shareGuide.createUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 border border-ok/50 px-2 py-1 text-[10px] tracking-wider text-ok no-underline uppercase hover:text-hover"
                  >
                    Create {shareGuide.slug}.json
                    <Icon icon={ExternalLink} size={9} />
                  </a>
                  {shareGuide.share.edit_index_url && (
                    <a
                      href={shareGuide.share.edit_index_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 border border-grid px-2 py-1 text-[10px] tracking-wider text-muted no-underline uppercase hover:text-hover"
                    >
                      Edit index.json
                      <Icon icon={ExternalLink} size={9} />
                    </a>
                  )}
                  {shareGuide.share.community_readme && (
                    <a
                      href={shareGuide.share.community_readme}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 border border-grid px-2 py-1 text-[10px] tracking-wider text-muted no-underline uppercase hover:text-hover"
                    >
                      Full README
                      <Icon icon={ExternalLink} size={9} />
                    </a>
                  )}
                </div>
              </li>
              <li className="border border-grid p-2.5 text-[11px] text-muted">
                <span className="text-[10px] tracking-wider text-dim uppercase">4 · Open the PR</span>
                <p className="mt-1">
                  After both files are on your fork branch, GitHub’s “Contribute → Open pull request” sends it to the bot repo. Maintainers merge → gallery updates (community cache ~10 min).
                </p>
              </li>
            </ol>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-fg"
                onClick={() => setShareGuide(null)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
