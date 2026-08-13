import { useEffect, useState, type ReactNode } from "react";
import {
  generateWallet,
  importWallet,
  unlockWallet,
  type SetupStatus,
} from "@/lib/api";
import { Icon } from "@/lib/icons";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, Copy, KeyRound, Shield, X,
} from "lucide-react";

type Mode = "create" | "import";
type Step =
  | "warn"
  | "password"
  | "retype"
  | "importKey"
  | "dash"
  | "review"
  | "working"
  | "backup"
  | "done";

function passScore(p: string): number {
  let s = 0;
  if (p.length >= 10) s += 1;
  if (p.length >= 14) s += 1;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s += 1;
  if (/\d/.test(p)) s += 1;
  if (/[^A-Za-z0-9]/.test(p)) s += 1;
  return s;
}

function passLabel(score: number): { text: string; tone: string } {
  if (score <= 1) return { text: "too weak", tone: "text-danger" };
  if (score === 2) return { text: "fair", tone: "text-warn" };
  if (score === 3) return { text: "ok", tone: "text-accent" };
  return { text: "strong", tone: "text-ok" };
}

function CheckRow({
  checked, onChange, children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 border border-grid px-2.5 py-2 text-[12px] leading-snug text-muted hover:border-muted">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

export function WalletCreateModal({
  mode,
  overwrite,
  initialDashToken = "",
  unlockAfter = true,
  onCancel,
  onDone,
}: {
  mode: Mode;
  overwrite: boolean;
  initialDashToken?: string;
  unlockAfter?: boolean;
  onCancel: () => void;
  onDone: (info: {
    status: SetupStatus;
    publicKey: string;
    secretOnce: string | null;
  }) => void;
}) {
  const [step, setStep] = useState<Step>("warn");
  const [err, setErr] = useState<string | null>(null);

  const [ackBurner, setAckBurner] = useState(false);
  const [ackNoRecover, setAckNoRecover] = useState(false);
  const [ackOnce, setAckOnce] = useState(false);
  const [ackOverwrite, setAckOverwrite] = useState(!overwrite);

  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [retype, setRetype] = useState("");
  const [secret, setSecret] = useState("");
  const [dash, setDash] = useState(initialDashToken);
  const [doUnlock, setDoUnlock] = useState(unlockAfter);

  const [secretOnce, setSecretOnce] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [copied, setCopied] = useState(false);
  const [ackSaved, setAckSaved] = useState(false);
  const [ackOffline, setAckOffline] = useState(false);
  const [tailConfirm, setTailConfirm] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step !== "working" && step !== "backup") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, step]);

  const score = passScore(pass);
  const strength = passLabel(score);
  const passOk = pass.length >= 10 && score >= 2 && pass === pass2;
  const retypeOk = retype.length > 0 && retype === pass;
  const warnOk = ackBurner && ackNoRecover && ackOnce && ackOverwrite;
  const backupTail = secretOnce ? secretOnce.slice(-6) : "";
  const backupOk = !!secretOnce
    && ackSaved
    && ackOffline
    && tailConfirm.trim() === backupTail;

  const title =
    mode === "create" ? "Create burner wallet" : "Import Phantom burner";

  const go = (next: Step) => {
    setErr(null);
    setStep(next);
  };

  const runCreate = async () => {
    setErr(null);
    setStep("working");
    try {
      if (!dash.trim()) throw new Error("re-enter your dash token");
      if (pass !== retype) throw new Error("password retype does not match");
      if (mode === "import" && !secret.trim()) throw new Error("paste the Phantom private key");

      let nextStatus: SetupStatus;
      let pk: string;
      let once: string | null = null;

      if (mode === "create") {
        const r = await generateWallet({
          confirm: dash,
          passphrase: pass,
          overwrite,
        });
        nextStatus = r.status;
        pk = r.publicKey;
        once = r.secretOnce;
      } else {
        const r = await importWallet({
          confirm: dash,
          passphrase: pass,
          secret: secret.trim(),
          overwrite,
        });
        nextStatus = r.status;
        pk = r.publicKey;
        once = null;
      }

      if (doUnlock) {
        const u = await unlockWallet({ confirm: dash, passphrase: pass });
        nextStatus = u.status;
        pk = u.publicKey;
      }

      setStatus(nextStatus);
      setPublicKey(pk);
      setSecretOnce(once);
      setSecret("");

      if (once) go("backup");
      else {
        setStep("done");
      }
    } catch (e) {
      setErr((e as Error).message);
      setStep("review");
    }
  };

  const finish = () => {
    if (!status || !publicKey) return;
    onDone({ status, publicKey, secretOnce });
  };

  const copySecret = async () => {
    if (!secretOnce) return;
    try {
      await navigator.clipboard.writeText(secretOnce);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("clipboard blocked — select and copy manually");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 p-3 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && step !== "working" && step !== "backup") onCancel();
      }}
    >
      <div className="panel flex max-h-[92vh] w-full max-w-lg flex-col shadow-[0_20px_60px_rgba(0,0,0,0.65)]">
        <header className="flex shrink-0 items-center justify-between border-b border-grid px-3 py-2.5">
          <div>
            <div className="font-display text-[13px] font-semibold tracking-wide text-fg">{title}</div>
            <div className="text-[10px] tracking-wider text-dim uppercase">
              {step === "warn" && "Step 1 · warnings"}
              {step === "password" && "Step 2 · set password"}
              {step === "retype" && "Step 3 · type password again"}
              {step === "importKey" && "Step 4 · private key"}
              {step === "dash" && "Authorize"}
              {step === "review" && "Final check"}
              {step === "working" && "Working…"}
              {step === "backup" && "Backup private key"}
              {step === "done" && "Done"}
            </div>
          </div>
          {step !== "working" && step !== "backup" && (
            <button type="button" className="text-dim hover:text-hover" aria-label="Close" onClick={onCancel}>
              <Icon icon={X} size={14} />
            </button>
          )}
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {err && (
            <div className="border border-danger/60 bg-bg px-2.5 py-2 text-[11px] text-danger">{err}</div>
          )}

          {step === "warn" && (
            <>
              <div className="flex items-start gap-2 border border-warn/40 bg-bg px-2.5 py-2 text-[12px] text-warn">
                <Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" />
                <span>
                  Nobody can recover this password or private key for you.
                  If you lose them, the funds are gone.
                </span>
              </div>
              <CheckRow checked={ackBurner} onChange={setAckBurner}>
                I will use a <span className="text-warn">burner wallet only</span> — never my main wallet.
              </CheckRow>
              <CheckRow checked={ackNoRecover} onChange={setAckNoRecover}>
                I will remember this wallet password. Support cannot reset it.
              </CheckRow>
              <CheckRow checked={ackOnce} onChange={setAckOnce}>
                {mode === "create"
                  ? "I understand the private key is shown once after create — I will save it offline."
                  : "I understand I’m pasting a private key that can move funds — burner only."}
              </CheckRow>
              {overwrite && (
                <CheckRow checked={ackOverwrite} onChange={setAckOverwrite}>
                  I understand this <span className="text-danger">replaces</span> the existing encrypted wallet on this host.
                </CheckRow>
              )}
            </>
          )}

          {step === "password" && (
            <>
              <p className="text-[12px] text-dim">
                Pick a long password you’ll actually remember. Min 10 characters.
                Mix letters, numbers, or symbols.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Wallet password</span>
                <input
                  className="input-field"
                  type="password"
                  autoComplete="new-password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  placeholder="at least 10 characters"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Confirm password</span>
                <input
                  className="input-field"
                  type="password"
                  autoComplete="new-password"
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                />
              </label>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-dim">Strength</span>
                <span className={strength.tone}>{strength.text}</span>
              </div>
              <div className="flex gap-1">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 ${
                      score > i
                        ? score <= 1 ? "bg-danger" : score === 2 ? "bg-warn" : "bg-ok"
                        : "bg-grid"
                    }`}
                  />
                ))}
              </div>
              {pass2 && pass !== pass2 && (
                <p className="text-[11px] text-danger">Passwords do not match.</p>
              )}
            </>
          )}

          {step === "retype" && (
            <>
              <div className="flex items-start gap-2 border border-accent/40 bg-bg px-2.5 py-2 text-[12px] text-muted">
                <Icon icon={Shield} size={14} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  Type the same password again from memory (don’t paste from a notes app if you can avoid it).
                  This proves you can recall it.
                </span>
              </div>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Wallet password (again)</span>
                <input
                  className="input-field"
                  type="password"
                  autoComplete="off"
                  value={retype}
                  onChange={(e) => setRetype(e.target.value)}
                  placeholder="re-type from memory"
                />
              </label>
              {retype && !retypeOk && (
                <p className="text-[11px] text-danger">That doesn’t match what you set.</p>
              )}
              {retypeOk && (
                <p className="text-[11px] text-ok">Match — good.</p>
              )}
            </>
          )}

          {step === "importKey" && (
            <>
              <p className="text-[12px] text-dim">
                Paste the Phantom private key for your <span className="text-warn">burner</span> only.
                It is encrypted with your password and not shown again.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Phantom private key</span>
                <input
                  className="input-field"
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="base58 secret"
                />
              </label>
            </>
          )}

          {step === "dash" && (
            <>
              <p className="text-[12px] text-dim">
                Re-enter your dashboard login token so we know it’s you authorizing this wallet write.
              </p>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Dash token</span>
                <input
                  className="input-field"
                  type="password"
                  autoComplete="off"
                  value={dash}
                  onChange={(e) => setDash(e.target.value)}
                  placeholder="DASH_TOKEN"
                />
              </label>
              <label className="flex items-center gap-2 text-[12px] text-muted">
                <input
                  type="checkbox"
                  checked={doUnlock}
                  onChange={(e) => setDoUnlock(e.target.checked)}
                />
                Unlock into .env now (needed for live trading)
              </label>
            </>
          )}

          {step === "review" && (
            <>
              <ul className="space-y-1.5 text-[12px] text-muted">
                <li>· Action: {mode === "create" ? "create new burner" : "import Phantom burner"}</li>
                <li>· Password: set ({pass.length} chars, {strength.text})</li>
                <li>· Retype check: passed</li>
                {mode === "import" && <li>· Private key: pasted</li>}
                <li>· Unlock after: {doUnlock ? "yes" : "no — unlock later"}</li>
                {overwrite && <li className="text-warn">· Replaces existing encrypted wallet</li>}
              </ul>
              <p className="text-[11px] text-dim">
                Last chance to cancel. After this, remember the password and (for create) save the one-time private key backup.
              </p>
            </>
          )}

          {step === "working" && (
            <p className="py-6 text-center text-[12px] text-dim">Encrypting wallet…</p>
          )}

          {step === "backup" && secretOnce && (
            <>
              <div className="border border-warn/50 bg-bg px-2.5 py-2 text-[12px] leading-snug text-warn">
                This private key is shown <span className="text-fg">once</span>.
                Copy it to a password manager or paper offline. Closing without saving = you may lose access.
              </div>
              {publicKey && (
                <div className="text-[11px] text-dim">
                  Address · <span className="font-mono text-ok">{publicKey}</span>
                </div>
              )}
              <code className="block break-all border border-grid bg-bg p-2 font-mono text-[10px] text-fg">
                {secretOnce}
              </code>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 border border-grid px-2.5 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
                onClick={() => void copySecret()}
              >
                <Icon icon={copied ? Check : Copy} size={12} />
                {copied ? "Copied" : "Copy private key"}
              </button>
              <CheckRow checked={ackSaved} onChange={setAckSaved}>
                I saved this private key somewhere safe (offline / password manager).
              </CheckRow>
              <CheckRow checked={ackOffline} onChange={setAckOffline}>
                I will not paste this key into random websites or chat apps.
              </CheckRow>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">
                  Type the last 6 characters of the private key to confirm you have it
                </span>
                <input
                  className="input-field"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={tailConfirm}
                  onChange={(e) => setTailConfirm(e.target.value.trim())}
                  placeholder="······"
                />
              </label>
            </>
          )}

          {step === "done" && (
            <div className="space-y-2 py-2 text-[12px]">
              <p className="text-ok">Wallet ready.</p>
              {publicKey && (
                <p className="break-all font-mono text-[11px] text-muted">{publicKey}</p>
              )}
              <p className="text-dim">
                {doUnlock
                  ? "Unlocked into .env — restart the bot if it was already running."
                  : "Still locked — use Unlock on Settings when you want the bot to trade."}
              </p>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-grid px-3 py-2.5">
          {step !== "working" && step !== "backup" && step !== "done" ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 border border-grid px-2.5 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
              onClick={() => {
                if (step === "warn") onCancel();
                else if (step === "password") go("warn");
                else if (step === "retype") go("password");
                else if (step === "importKey") go("retype");
                else if (step === "dash") go(mode === "import" ? "importKey" : "retype");
                else if (step === "review") go("dash");
              }}
            >
              <Icon icon={ArrowLeft} size={12} />
              Back
            </button>
          ) : <span />}

          {step === "warn" && (
            <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={!warnOk} onClick={() => go("password")}>
              I understand <Icon icon={ArrowRight} size={12} />
            </button>
          )}
          {step === "password" && (
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={!passOk}
              onClick={() => {
                setRetype("");
                go("retype");
              }}
            >
              Next <Icon icon={ArrowRight} size={12} />
            </button>
          )}
          {step === "retype" && (
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={!retypeOk}
              onClick={() => go(mode === "import" ? "importKey" : "dash")}
            >
              Next <Icon icon={ArrowRight} size={12} />
            </button>
          )}
          {step === "importKey" && (
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={secret.trim().length < 32}
              onClick={() => go("dash")}
            >
              Next <Icon icon={ArrowRight} size={12} />
            </button>
          )}
          {step === "dash" && (
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={!dash.trim()}
              onClick={() => go("review")}
            >
              Review <Icon icon={ArrowRight} size={12} />
            </button>
          )}
          {step === "review" && (
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5"
              onClick={() => void runCreate()}
            >
              <Icon icon={KeyRound} size={12} />
              {mode === "create" ? "Create wallet" : "Import & encrypt"}
            </button>
          )}
          {step === "backup" && (
            <button
              type="button"
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={!backupOk}
              onClick={() => {
                setSecretOnce(null);
                setStep("done");
              }}
            >
              I’ve saved it — continue
            </button>
          )}
          {step === "done" && (
            <button type="button" className="btn-primary inline-flex items-center gap-1.5" onClick={finish}>
              Done
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
