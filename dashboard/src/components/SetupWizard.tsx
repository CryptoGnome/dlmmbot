import { useState } from "react";
import {
  completeSetup,
  patchConfig,
  patchSecrets,
  type SetupStatus,
} from "@/lib/api";
import { Badge } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { WalletCreateModal } from "@/components/WalletCreateModal";
import {
  ArrowRight, KeyRound, Shield, Sparkles, Wallet,
} from "lucide-react";

const STEPS = [
  { id: "welcome", label: "Welcome" },
  { id: "rpc", label: "RPC" },
  { id: "wallet", label: "Wallet" },
  { id: "mode", label: "Mode" },
  { id: "done", label: "Go" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

export function SetupWizard({
  initial,
  onDone,
}: {
  initial: SetupStatus;
  onDone: () => void;
}) {
  const [step, setStep] = useState<StepId>("welcome");
  const [status, setStatus] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [confirm, setConfirm] = useState("");
  const [rpc, setRpc] = useState("");
  const [walletTab, setWalletTab] = useState<"create" | "import">("create");
  const [walletModal, setWalletModal] = useState<"create" | "import" | null>(null);
  const [mode, setMode] = useState<"paper" | "live">("paper");

  const idx = STEPS.findIndex((s) => s.id === step);
  const walletReady = !!(status.wallet.encrypted || status.wallet.unlocked || status.wallet.ready);

  const goNext = () => {
    const next = STEPS[Math.min(STEPS.length - 1, idx + 1)];
    if (next) setStep(next.id);
  };

  const saveRpc = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!confirm.trim()) throw new Error("re-enter your dash token");
      if (!rpc.trim().startsWith("http")) throw new Error("RPC URL must start with https://");
      await patchSecrets(confirm, { RPC_URL: rpc.trim() });
      setStatus((s) => ({ ...s, hasRpc: true }));
      goNext();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finishMode = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patchConfig({ "exec.mode": mode });
      if (confirm.trim()) {
        await patchSecrets(confirm, { FARMER_MODE: mode });
      }
      goNext();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (skipped = false) => {
    setBusy(true);
    setErr(null);
    try {
      await completeSetup({ skipped });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="panel w-full max-w-xl max-h-[92vh] overflow-y-auto shadow-[0_0_0_1px_rgba(0,255,133,0.15)]">
        <header className="flex items-start justify-between gap-3 border-b border-grid px-4 py-3">
          <div>
            <div className="font-display flex items-center gap-2 text-sm font-semibold tracking-wide">
              <Icon icon={Sparkles} size={16} className="text-ok" />
              Setup
            </div>
            <p className="mt-0.5 text-[11px] text-dim">
              {STEPS[idx]?.label} · {idx + 1}/{STEPS.length}
            </p>
          </div>
          <Badge tone="accent">first run</Badge>
        </header>

        <div className="flex gap-1 border-b border-grid px-3 py-2">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`h-1 flex-1 ${i <= idx ? "bg-ok" : "bg-grid"}`}
              title={s.label}
            />
          ))}
        </div>

        <div className="space-y-4 p-4">
          {err && (
            <div className="border border-danger/60 bg-bg px-3 py-2 text-[11px] text-danger">{err}</div>
          )}

          {step === "welcome" && (
            <div className="space-y-3">
              <p className="text-[13px] leading-relaxed text-muted">
                A few steps so the bot can talk to Solana and hold a burner wallet.
                Paper mode first — live later when you’re ready.
              </p>
              <ul className="space-y-1 text-[11px] text-dim">
                <li className="flex items-center gap-2"><Icon icon={Shield} size={12} className="text-ok" /> Dash token gates secret writes</li>
                <li className="flex items-center gap-2"><Icon icon={KeyRound} size={12} className="text-ok" /> Wallet encrypted at rest</li>
                <li className="flex items-center gap-2"><Icon icon={Wallet} size={12} className="text-ok" /> Burner only — never your main</li>
              </ul>
              <div className="space-y-2">
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
                  className="btn-primary inline-flex items-center gap-1.5"
                  disabled={!confirm.trim()}
                  onClick={goNext}
                >
                  Continue <Icon icon={ArrowRight} size={12} />
                </button>
              </div>
            </div>
          )}

          {step === "rpc" && (
            <div className="space-y-3">
              <p className="text-[12px] text-muted">
                Private RPC from Helius / QuickNode / etc. Public endpoints are too slow and rate-limit hard.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">RPC URL</span>
                <input
                  className="input-field"
                  value={rpc}
                  onChange={(e) => setRpc(e.target.value)}
                  placeholder="https://…"
                  spellCheck={false}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-1.5"
                  disabled={busy || !rpc.trim()}
                  onClick={() => void saveRpc()}
                >
                  {busy ? "Saving…" : "Save & continue"}
                </button>
                {status.hasRpc && (
                  <button
                    type="button"
                    className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase"
                    onClick={goNext}
                  >
                    Already set — skip
                  </button>
                )}
              </div>
            </div>
          )}

          {step === "wallet" && (
            <div className="space-y-3">
              <p className="text-[12px] text-muted">
                Create or import a burner through the secure checklist (password retype + one-time backup).
                Never use your main wallet.
              </p>
              <div className="flex gap-1 border border-grid p-0.5">
                {(["create", "import"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`flex-1 px-2 py-1.5 text-[11px] tracking-wider uppercase ${
                      walletTab === t ? "bg-ok/15 text-ok" : "text-dim hover:text-muted"
                    }`}
                    onClick={() => setWalletTab(t)}
                  >
                    {t === "create" ? "Create new" : "Import Phantom"}
                  </button>
                ))}
              </div>

              {status.wallet.publicKey && (
                <p className="text-[11px] text-ok">
                  Wallet {status.wallet.publicKey.slice(0, 4)}…{status.wallet.publicKey.slice(-4)}
                  {status.wallet.unlocked ? " · unlocked" : status.wallet.encrypted ? " · encrypted" : ""}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {!walletReady && (
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-1.5"
                    onClick={() => {
                      if (!confirm.trim()) {
                        setErr("re-enter your dash token on the Welcome step first");
                        return;
                      }
                      setWalletModal(walletTab);
                    }}
                  >
                    <Icon icon={KeyRound} size={12} />
                    {walletTab === "create" ? "Start secure create…" : "Start secure import…"}
                  </button>
                )}
                {walletReady && (
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-1.5"
                    onClick={goNext}
                  >
                    Continue <Icon icon={ArrowRight} size={12} />
                  </button>
                )}
                {walletReady && (
                  <button
                    type="button"
                    className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase"
                    onClick={() => setWalletModal(walletTab)}
                  >
                    Replace wallet…
                  </button>
                )}
              </div>
            </div>
          )}

          {step === "mode" && (
            <div className="space-y-3">
              <p className="text-[12px] text-muted">
                Paper simulates fills without sending transactions. Live spends real SOL from the unlocked wallet.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  { id: "paper" as const, title: "Paper", blurb: "Safe default. Learn the UI & signals first." },
                  { id: "live" as const, title: "Live", blurb: "Real trades. Fund the wallet first." },
                ]).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={`border px-3 py-3 text-left ${
                      mode === m.id ? "border-ok/60 bg-ok/10" : "border-grid hover:border-muted"
                    }`}
                    onClick={() => setMode(m.id)}
                  >
                    <div className={`text-[12px] font-semibold tracking-wider uppercase ${
                      mode === m.id ? "text-ok" : "text-muted"
                    }`}>{m.title}</div>
                    <p className="mt-1 text-[10px] text-dim">{m.blurb}</p>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-1.5"
                disabled={busy}
                onClick={() => void finishMode()}
              >
                {busy ? "Saving…" : "Continue"}
              </button>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-3">
              <p className="text-[13px] text-muted">
                Core is set. Tune size, risk, and pool filters anytime under{" "}
                <span className="text-ok">Settings</span>. Re-run wallet unlock there after redeploys
                (or set <code className="text-accent">WALLET_PASSPHRASE</code> on Railway).
              </p>
              <ul className="space-y-1 text-[11px] text-dim">
                <li>RPC · {status.hasRpc || rpc ? "ready" : "missing"}</li>
                <li>
                  Wallet · {status.wallet.publicKey
                    ? `${status.wallet.publicKey.slice(0, 8)}…`
                    : "missing"}
                  {status.wallet.unlocked ? " (unlocked)" : status.wallet.encrypted ? " (locked)" : ""}
                </li>
                <li>Mode · {mode}</li>
              </ul>
              <button
                type="button"
                className="btn-primary inline-flex items-center gap-1.5"
                disabled={busy}
                onClick={() => void finish(false)}
              >
                {busy ? "Finishing…" : "Finish setup"}
              </button>
            </div>
          )}
        </div>
      </div>

      {walletModal && (
        <WalletCreateModal
          mode={walletModal}
          overwrite={!!status.wallet.encrypted}
          initialDashToken={confirm}
          unlockAfter
          onCancel={() => setWalletModal(null)}
          onDone={({ status: next }) => {
            setStatus(next);
            setWalletModal(null);
            setErr(null);
          }}
        />
      )}
    </div>
  );
}
