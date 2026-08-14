import { useEffect, useState } from "react";
import {
  acceptTerms,
  fetchTerms,
  type SetupStatus,
} from "@/lib/api";
import { Badge } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { ShieldAlert } from "lucide-react";

/** Blocking overlay for existing installs that have not accepted the current TERMS version. */
export function TermsGate({
  initial,
  onAccepted,
}: {
  initial: SetupStatus;
  onAccepted: (next: SetupStatus) => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [version, setVersion] = useState(initial.termsVersion);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = await fetchTerms();
        if (cancelled) return;
        setMarkdown(t.markdown);
        setVersion(t.version);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!confirm.trim()) throw new Error("re-enter your dash token");
      if (!accepted) throw new Error("you must accept the Terms to continue");
      const next = await acceptTerms({ confirm: confirm.trim(), version });
      onAccepted(next);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="panel w-full max-w-xl max-h-[92vh] overflow-y-auto shadow-[0_0_0_1px_rgba(255,77,106,0.25)]">
        <header className="flex items-start justify-between gap-3 border-b border-grid px-4 py-3">
          <div>
            <div className="font-display flex items-center gap-2 text-sm font-semibold tracking-wide">
              <Icon icon={ShieldAlert} size={16} className="text-danger" />
              Terms required
            </div>
            <p className="mt-0.5 text-[11px] text-dim">
              Version {version} · free software · you run it at your own risk
            </p>
          </div>
          <Badge tone="danger">waiver</Badge>
        </header>

        <div className="space-y-3 p-4">
          {err && (
            <div className="border border-danger/60 bg-bg px-3 py-2 text-[11px] text-danger">{err}</div>
          )}
          <p className="text-[12px] leading-relaxed text-muted">
            Before using the dashboard, accept the Terms of Service &amp; Risk Waiver.
            You can lose 100%. We are not liable for losses, bugs, or third-party failures.
          </p>
          <div className="max-h-56 overflow-y-auto border border-grid bg-bg p-3 text-[10px] leading-relaxed whitespace-pre-wrap text-dim">
            {markdown ?? "Loading terms…"}
          </div>
          <label className="flex items-start gap-2 text-[11px] text-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>
              I have read and accept the Terms of Service &amp; Risk Waiver (v{version}),
              including the waiver of claims and limitation of liability.
            </span>
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] text-muted">Confirm dash token</span>
            <input
              className="input-field"
              type="password"
              autoComplete="off"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="same token as the URL"
            />
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !accepted || !confirm.trim()}
            onClick={() => void submit()}
          >
            {busy ? "Saving…" : "Accept & continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
