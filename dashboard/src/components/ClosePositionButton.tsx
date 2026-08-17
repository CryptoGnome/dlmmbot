import { useState } from "react";
import { X, TriangleAlert } from "lucide-react";
import { closePosition } from "@/lib/api";
import { fmtSol } from "@/lib/utils";
import { toast } from "@/lib/toast";

/**
 * Operator close for a single position.
 *
 * The click does NOT close anything by itself — the dashboard holds no wallet.
 * It records the request; the farmer performs the real on-chain close on its
 * next manage tick and reports the PnL like any other exit. The dialog says so,
 * because "closed" appearing instantly when it has not happened yet is exactly
 * the kind of lie that costs money.
 *
 * The dash token has to be re-entered, matching HALT and blacklist-clear: this
 * moves real funds and cannot be undone, so an unattended tab is not enough.
 */
export function ClosePositionButton({
  id, symbol, entrySol, pnlSol, rangeStatus, requestedAt,
}: {
  id: number;
  symbol: string;
  entrySol?: number | null;
  pnlSol?: number | null;
  rangeStatus?: string;
  requestedAt?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pending = requestedAt != null;

  async function confirm() {
    if (busy || !token) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await closePosition(id, token);
      setOpen(false);
      setToken("");
      toast({
        title: res.already ? `pos#${id} ${symbol} already queued` : `pos#${id} ${symbol} queued to close`,
        detail: "The farmer closes it on the next manage tick and reports the PnL.",
        tone: "ok",
        kind: "event",
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <span
        className="inline-flex items-center gap-1 border border-warn/50 px-2 py-1 text-[10px] tracking-wider text-warn uppercase"
        title={`Close requested ${new Date(requestedAt! * 1000).toLocaleTimeString()} — the farmer actions it on the next manage tick.`}
      >
        <TriangleAlert size={10} strokeWidth={1.75} aria-hidden />
        Closing…
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setErr(null); setOpen(true); }}
        className="inline-flex items-center gap-1 border border-danger/60 px-2 py-1 text-[10px] tracking-wider text-danger uppercase hover:border-danger hover:bg-danger/10"
        title="Close this position now"
      >
        <X size={10} strokeWidth={2} aria-hidden />
        Close
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Close position ${id}`}
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}
        >
          <div className="w-full max-w-sm border border-danger/60 bg-panel p-4">
            <div className="flex items-center gap-2 text-danger">
              <TriangleAlert size={14} strokeWidth={2} aria-hidden />
              <span className="text-[11px] tracking-wider uppercase">Close position</span>
            </div>

            <p className="mt-3 text-[12px] text-fg">
              Close <span className="text-accent">#{id} {symbol}</span> now?
            </p>

            <dl className="mt-2 space-y-0.5 text-[11px] text-muted">
              {entrySol != null && (
                <div className="flex justify-between gap-3">
                  <dt>Size</dt><dd className="text-fg">{fmtSol(entrySol, 4)}</dd>
                </div>
              )}
              {pnlSol != null && (
                <div className="flex justify-between gap-3">
                  <dt>Unrealised</dt>
                  <dd className={pnlSol < 0 ? "text-danger" : "text-ok"}>{fmtSol(pnlSol, 4)}</dd>
                </div>
              )}
              {rangeStatus && (
                <div className="flex justify-between gap-3">
                  <dt>Range</dt><dd className="text-fg">{rangeStatus}</dd>
                </div>
              )}
            </dl>

            <p className="mt-3 border border-grid bg-bg/40 p-2 text-[10px] leading-relaxed text-muted">
              This sells the position on chain and cannot be undone. The farmer performs
              the close on its next manage tick — it is not instant, and the realised PnL
              may differ from the figure above.
            </p>

            <label className="mt-3 block text-[10px] tracking-wider text-muted uppercase">
              Re-enter dash token
              <input
                type="password"
                autoFocus
                value={token}
                disabled={busy}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }}
                className="mt-1 w-full border border-grid bg-bg px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent"
              />
            </label>

            {err && <p className="mt-2 text-[10px] text-danger">{err}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="border border-grid px-3 py-1 text-[10px] tracking-wider text-muted uppercase hover:text-fg disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !token}
                onClick={() => void confirm()}
                className="border border-danger bg-danger/15 px-3 py-1 text-[10px] tracking-wider text-danger uppercase hover:bg-danger/25 disabled:opacity-40"
              >
                {busy ? "Requesting…" : "Close position"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
