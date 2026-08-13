import { useState } from "react";
import {
  completeSetup,
  generateWallet,
  importWallet,
  patchConfig,
  patchSecrets,
  unlockWallet,
  type SetupStatus,
} from "@/lib/api";
import { Badge } from "@/components/ui";
import { Icon } from "@/lib/icons";
import {
  ArrowRight, Check, Copy, KeyRound, Shield, Sparkles, Wallet,
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
  const [passphrase, setPassphrase] = useState("");
  const [pass2, setPass2] = useState("");
  const [phantomSecret, setPhantomSecret] = useState("");
  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [unlockNow, setUnlockNow] = useState(true);

  const idx = STEPS.findIndex((s) => s.id === step);

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

  const saveWallet = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!confirm.trim()) throw new Error("re-enter your dash token");
      if (passphrase.length < 8) throw new Error("passphrase must be at least 8 characters");
      if (passphrase !== pass2) throw new Error("passphrases do not match");
      if (walletTab === "create") {
        const r = await generateWallet({
          confirm,
          passphrase,
          overwrite: status.wallet.encrypted,
        });
        setSecretOnce(r.secretOnce);
        setStatus(r.status);
      } else {
        if (!phantomSecret.trim()) throw new Error("paste your Phantom private key");
        const r = await importWallet({
          confirm,
          passphrase,
          secret: phantomSecret.trim(),
          overwrite: status.wallet.encrypted,
        });
        setSecretOnce(null);
        setStatus(r.status);
        setPhantomSecret("");
      }
      if (unlockNow) {
        const u = await unlockWallet({ confirm, passphrase });
        setStatus(u.status);
      }
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

  const copySecret = async () => {
    if (!secretOnce) return;
    try {
      await navigator.clipboard.writeText(secretOnce);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("clipboard blocked — select and copy manually");
    }
  };

  const walletReady = status.wallet.encrypted || status.wallet.unlocked;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-xl max-h-[92vh] overflow-y-auto shadow-[0_0_0_1px_rgba(0,255,133,0.15)]">
        <header className="border-b border-grid px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] tracking-[0.2em] text-dim uppercase">First-run setup</p>
              <h1 className="font-display text-lg font-semibold tracking-wide text-fg">
                Get the core online
              </h1>
            </div>
            <Badge tone="accent">{idx + 1}/{STEPS.length}</Badge>
          </div>
          <div className="mt-3 flex gap-1">
            {STEPS.map((s, i) => (
              <div
                key={s.id}
                className={`h-0.5 flex-1 ${i <= idx ? "bg-ok" : "bg-grid"}`}
                title={s.label}
              />
            ))}
          </div>
        </header>

        <div className="space-y-4 p-4">
          {err && (
            <div className="border border-danger/60 bg-bg px-3 py-2 text-[11px] text-danger">
              {err}
            </div>
          )}

          {step === "welcome" && (
            <div className="space-y-4">
              <p className="text-[13px] leading-relaxed text-muted">
                This wizard fills the <span className="text-ok">core</span> settings so the bot
                can scan pools and (when you switch to live) trade. Paper mode is safe until you
                unlock a wallet.
              </p>
              <ul className="space-y-2 text-[12px] text-dim">
                <li className="flex gap-2">
                  <Icon icon={Shield} size={14} className="mt-0.5 shrink-0 text-accent" />
                  <span>RPC — how the bot talks to Solana (Helius / QuickNode / etc.).</span>
                </li>
                <li className="flex gap-2">
                  <Icon icon={Wallet} size={14} className="mt-0.5 shrink-0 text-accent" />
                  <span>Wallet — create a new encrypted keypair or import from Phantom.</span>
                </li>
                <li className="flex gap-2">
                  <Icon icon={Sparkles} size={14} className="mt-0.5 shrink-0 text-accent" />
                  <span>Mode — start in paper; go live after you fund the wallet.</span>
                </li>
              </ul>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Confirm dash token</span>
                <input
                  className="input-field"
                  type="password"
                  autoComplete="off"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="same token as ?token=…"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-1.5"
                  disabled={!confirm.trim()}
                  onClick={goNext}
                >
                  Start <Icon icon={ArrowRight} size={12} />
                </button>
                <button
                  type="button"
                  className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-dim uppercase hover:text-hover"
                  disabled={busy}
                  onClick={() => void finish(true)}
                >
                  Skip for now
                </button>
              </div>
            </div>
          )}

          {step === "rpc" && (
            <div className="space-y-3">
              <p className="text-[12px] text-muted">
                Paste an HTTPS Solana RPC. Public endpoints rate-limit hard — a paid Helius /
                QuickNode URL is strongly recommended.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">RPC_URL</span>
                <input
                  className="input-field"
                  value={rpc}
                  onChange={(e) => setRpc(e.target.value)}
                  placeholder="https://mainnet.helius-rpc.com/?api-key=…"
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
                Keys are encrypted with your passphrase (AES-256-GCM) and stored on the volume.
                The private key is only written to <code className="text-ok">.env</code> when you unlock.
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

              {walletTab === "import" && (
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted">Phantom private key (base58)</span>
                  <input
                    className="input-field"
                    type="password"
                    autoComplete="off"
                    value={phantomSecret}
                    onChange={(e) => setPhantomSecret(e.target.value)}
                    placeholder="paste export — never shown again after encrypt"
                  />
                </label>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted">Encrypt passphrase</span>
                  <input
                    className="input-field"
                    type="password"
                    autoComplete="new-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="min 8 chars"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted">Confirm passphrase</span>
                  <input
                    className="input-field"
                    type="password"
                    autoComplete="new-password"
                    value={pass2}
                    onChange={(e) => setPass2(e.target.value)}
                  />
                </label>
              </div>

              <label className="flex items-center gap-2 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={unlockNow}
                  onChange={(e) => setUnlockNow(e.target.checked)}
                />
                Unlock into .env now (needed for live trading)
              </label>

              {secretOnce && (
                <div className="space-y-2 border border-warn/50 bg-bg p-3">
                  <p className="text-[11px] text-warn">
                    Backup this secret key now — it is shown once. Store offline.
                  </p>
                  <code className="block break-all text-[10px] text-fg">{secretOnce}</code>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 border border-grid px-2 py-1 text-[10px] uppercase tracking-wider text-muted hover:text-hover"
                    onClick={() => void copySecret()}
                  >
                    <Icon icon={copied ? Check : Copy} size={11} />
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}

              {status.wallet.publicKey && (
                <p className="text-[11px] text-ok">
                  Wallet {status.wallet.publicKey.slice(0, 4)}…{status.wallet.publicKey.slice(-4)}
                  {status.wallet.unlocked ? " · unlocked" : " · encrypted"}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {!walletReady || secretOnce ? (
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-1.5"
                    disabled={busy}
                    onClick={() => void saveWallet()}
                  >
                    <Icon icon={KeyRound} size={12} />
                    {busy ? "Working…" : walletTab === "create" ? "Create & encrypt" : "Import & encrypt"}
                  </button>
                ) : null}
                {walletReady && (
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-1.5"
                    onClick={() => {
                      setSecretOnce(null);
                      goNext();
                    }}
                  >
                    Continue <Icon icon={ArrowRight} size={12} />
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
                <Icon icon={Check} size={12} />
                {busy ? "Closing…" : "Open dashboard"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
