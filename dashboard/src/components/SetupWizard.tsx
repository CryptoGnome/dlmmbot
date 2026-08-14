import { useEffect, useState } from "react";
import {
  acceptTerms,
  completeSetup,
  fetchTerms,
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
  { id: "apis", label: "RPC & APIs" },
  { id: "wallet", label: "Wallet" },
  { id: "mode", label: "Mode" },
  { id: "done", label: "Go" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

function walletIsReady(s: SetupStatus): boolean {
  return !!(s.wallet.encrypted || s.wallet.unlocked || s.wallet.ready);
}

/** After welcome/terms — jump past steps already satisfied by Railway/.env. */
function stepAfterWelcome(s: SetupStatus): StepId {
  if (!s.hasRpc || !s.hasJupiterApiKey) return "apis";
  if (!walletIsReady(s)) return "wallet";
  return "mode";
}

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
  const [termsOk, setTermsOk] = useState(
    !!initial.setup.termsVersion && initial.setup.termsVersion === initial.termsVersion,
  );
  const [termsMd, setTermsMd] = useState<string | null>(null);
  const [termsVersion, setTermsVersion] = useState(initial.termsVersion);
  const [rpc, setRpc] = useState("");
  const [jupiter, setJupiter] = useState("");
  const [gmgn, setGmgn] = useState("");
  const [walletTab, setWalletTab] = useState<"create" | "import">("create");
  const [walletModal, setWalletModal] = useState<"create" | "import" | null>(null);
  const [mode, setMode] = useState<"paper" | "live">(
    initial.farmerMode === "live" ? "live" : "paper",
  );

  const idx = STEPS.findIndex((s) => s.id === step);
  const walletReady = walletIsReady(status);
  const apisReady = status.hasRpc && status.hasJupiterApiKey;
  const rpcOk = status.hasRpc || !!rpc.trim();
  const jupiterOk = status.hasJupiterApiKey || !!jupiter.trim();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = await fetchTerms();
        if (cancelled) return;
        setTermsMd(t.markdown);
        setTermsVersion(t.version);
        setTermsOk((ok) => ok || initial.setup.termsVersion === t.version);
      } catch {
        /* welcome still shows checkbox; accept will fail loudly if needed */
      }
    })();
    return () => { cancelled = true; };
  }, [initial.setup.termsVersion]);

  const goNext = () => {
    const next = STEPS[Math.min(STEPS.length - 1, idx + 1)];
    if (next) setStep(next.id);
  };

  const startWizard = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!confirm.trim()) throw new Error("re-enter your dash token");
      if (!termsOk) throw new Error("accept the Terms of Service to continue");
      let next = status;
      if (status.needsTerms || status.setup.termsVersion !== termsVersion) {
        next = await acceptTerms({ confirm: confirm.trim(), version: termsVersion });
        setStatus(next);
      }
      setStep(stepAfterWelcome(next));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const continueApis = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!confirm.trim()) throw new Error("re-enter your dash token");
      const rpcVal = rpc.trim();
      const jupVal = jupiter.trim();
      const gmgnVal = gmgn.trim();
      if (!rpcVal && !status.hasRpc) throw new Error("RPC URL is required");
      if (rpcVal && !rpcVal.startsWith("http")) throw new Error("RPC URL must start with https://");
      if (!jupVal && !status.hasJupiterApiKey) {
        throw new Error("Jupiter API key is required for exit swaps");
      }
      const secrets: Record<string, string> = {};
      if (rpcVal) secrets.RPC_URL = rpcVal;
      if (jupVal) secrets.JUPITER_API_KEY = jupVal;
      if (gmgnVal) secrets.GMGN_API_KEY = gmgnVal;
      if (Object.keys(secrets).length) {
        await patchSecrets(confirm, secrets);
      }
      const next: SetupStatus = {
        ...status,
        hasRpc: status.hasRpc || !!rpcVal,
        hasJupiterApiKey: status.hasJupiterApiKey || !!jupVal,
        hasGmgnApiKey: status.hasGmgnApiKey || !!gmgnVal,
      };
      setStatus(next);
      setStep(walletIsReady(next) ? "mode" : "wallet");
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
              {(status.hasRpc || status.hasJupiterApiKey || status.hasGmgnApiKey || walletReady) && (
                <ul className="space-y-1 border border-ok/40 bg-ok/5 px-3 py-2 text-[11px] text-ok">
                  <li className="font-semibold tracking-wider uppercase text-[10px]">Already on this host</li>
                  {status.hasRpc && <li>RPC URL · set (Railway / .env)</li>}
                  {status.hasJupiterApiKey && <li>Jupiter API key · set</li>}
                  {status.hasGmgnApiKey && <li>GMGN API key · set</li>}
                  {walletReady && (
                    <li>
                      Wallet · {status.wallet.publicKey
                        ? `${status.wallet.publicKey.slice(0, 4)}…${status.wallet.publicKey.slice(-4)}`
                        : "ready"}
                    </li>
                  )}
                  <li className="text-dim">We’ll skip those steps after Terms.</li>
                </ul>
              )}

              <div className="space-y-2 border border-danger/40 bg-bg p-3">
                <div className="text-[11px] font-semibold tracking-wider text-danger uppercase">
                  Terms &amp; risk waiver (v{termsVersion})
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  Free software. You can lose 100%. Bugs and third-party failures happen.
                  We are not liable — you waive claims by accepting.
                </p>
                <div className="max-h-40 overflow-y-auto border border-grid p-2 text-[10px] leading-relaxed whitespace-pre-wrap text-dim">
                  {termsMd ?? "Loading full terms…"}
                </div>
                <label className="flex items-start gap-2 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={termsOk}
                    onChange={(e) => setTermsOk(e.target.checked)}
                  />
                  <span>
                    I have read and accept the{" "}
                    <a
                      href="https://dlmmbot.com/setup/terms"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline"
                    >
                      Terms of Service &amp; Risk Waiver
                    </a>
                    , including no warranty and waiver of liability.
                  </span>
                </label>
              </div>

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
                  disabled={busy || !confirm.trim() || !termsOk}
                  onClick={() => void startWizard()}
                >
                  {busy ? "Saving…" : <>Continue <Icon icon={ArrowRight} size={12} /></>}
                </button>
              </div>
            </div>
          )}

          {step === "apis" && (
            <div className="space-y-4">
              {apisReady && (
                <div className="border border-ok/40 bg-ok/5 px-3 py-2 text-[11px] text-ok">
                  RPC and Jupiter are already set on this host (Railway variables or `.env`).
                  Continue to keep them, or paste below to replace.
                </div>
              )}
              <div className="space-y-2 border border-grid p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold tracking-wider text-ok uppercase">Helius RPC (recommended)</div>
                  {status.hasRpc && <Badge tone="ok">set</Badge>}
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  Public Solana RPCs rate-limit hard. We suggest{" "}
                  <a
                    href="https://www.helius.dev/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    Helius
                  </a>
                  {" "}for mainnet reads and tx simulation.
                </p>
                {!status.hasRpc && (
                  <ol className="list-decimal space-y-0.5 pl-4 text-[10px] text-dim">
                    <li>
                      Sign up at{" "}
                      <a href="https://dashboard.helius.dev/signup" target="_blank" rel="noreferrer" className="text-accent underline">
                        dashboard.helius.dev
                      </a>
                    </li>
                    <li>Create a project → open <strong>RPC</strong> → copy the <strong>Mainnet</strong> HTTPS URL</li>
                    <li>Paste below (looks like <code className="text-accent">https://mainnet.helius-rpc.com/?api-key=…</code>)</li>
                  </ol>
                )}
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted">RPC URL</span>
                  <input
                    className="input-field"
                    value={rpc}
                    onChange={(e) => setRpc(e.target.value)}
                    placeholder={status.hasRpc ? "already set — paste to replace" : "https://mainnet.helius-rpc.com/?api-key=…"}
                    spellCheck={false}
                  />
                </label>
              </div>

              <div className="space-y-2 border border-grid p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold tracking-wider text-ok uppercase">Jupiter API key</div>
                  {status.hasJupiterApiKey && <Badge tone="ok">set</Badge>}
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  Live exits swap token → SOL through Jupiter. Paper simulates the path but still needs a key for{" "}
                  <code className="text-accent">simulate-zap</code> checks before going live.
                </p>
                {!status.hasJupiterApiKey && (
                  <ol className="list-decimal space-y-0.5 pl-4 text-[10px] text-dim">
                    <li>
                      Open{" "}
                      <a href="https://developers.jup.ag/portal" target="_blank" rel="noreferrer" className="text-accent underline">
                        developers.jup.ag/portal
                      </a>
                      {" "}and sign in (Google, GitHub, or email)
                    </li>
                    <li>Create or join a team → <strong>API Keys</strong> → <strong>Create</strong></li>
                    <li>Copy the key immediately — Jupiter shows the full value <strong>once</strong></li>
                    <li>
                      Free tier is enough to start (
                      <a href="https://developers.jup.ag/docs/portal/setup" target="_blank" rel="noreferrer" className="text-accent underline">
                        setup guide
                      </a>
                      )
                    </li>
                  </ol>
                )}
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted">Jupiter API key</span>
                  <input
                    className="input-field"
                    type="password"
                    autoComplete="off"
                    value={jupiter}
                    onChange={(e) => setJupiter(e.target.value)}
                    placeholder={status.hasJupiterApiKey ? "already set — paste to replace" : "paste key from Portal"}
                    spellCheck={false}
                  />
                </label>
              </div>

              <div className="space-y-2 border border-grid p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold tracking-wider text-muted uppercase">GMGN API key (optional)</div>
                  {status.hasGmgnApiKey && <Badge tone="ok">set</Badge>}
                </div>
                <p className="text-[11px] leading-relaxed text-muted">
                  Free trending + smart-money feeds and extra honeypot/sell-tax vetting. Skip if you want Meteora-only discovery for now.
                </p>
                {!status.hasGmgnApiKey && (
                  <ol className="list-decimal space-y-0.5 pl-4 text-[10px] text-dim">
                    <li>
                      Generate Ed25519 keys (terminal:{" "}
                      <code className="text-accent">openssl genpkey -algorithm Ed25519 …</code>
                      {" "}— full steps in{" "}
                      <a href="https://dlmmbot.com/setup/api-keys" target="_blank" rel="noreferrer" className="text-accent underline">
                        docs → API keys
                      </a>
                      )
                    </li>
                    <li>
                      Sign up at{" "}
                      <a href="https://gmgn.ai/ai" target="_blank" rel="noreferrer" className="text-accent underline">
                        gmgn.ai/ai
                      </a>
                      {" "}→ paste your <strong>public key</strong> → copy the API key
                    </li>
                    <li>Paste below — query key only; never put GMGN private keys in the bot</li>
                  </ol>
                )}
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted">GMGN API key</span>
                  <input
                    className="input-field"
                    type="password"
                    autoComplete="off"
                    value={gmgn}
                    onChange={(e) => setGmgn(e.target.value)}
                    placeholder={status.hasGmgnApiKey ? "already set — paste to replace" : "optional — paste from gmgn.ai/ai"}
                    spellCheck={false}
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-primary inline-flex items-center gap-1.5"
                  disabled={busy || !rpcOk || !jupiterOk}
                  onClick={() => void continueApis()}
                >
                  {busy ? "Saving…" : apisReady && !rpc.trim() && !jupiter.trim() && !gmgn.trim()
                    ? <>Keep env & continue <Icon icon={ArrowRight} size={12} /></>
                    : "Save & continue"}
                </button>
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
                <li>Jupiter · {status.hasJupiterApiKey || jupiter ? "ready" : "missing"}</li>
                <li>GMGN · {status.hasGmgnApiKey || gmgn ? "ready" : "optional — skipped"}</li>
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
