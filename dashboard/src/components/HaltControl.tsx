import { useEffect, useRef, useState } from "react";
import type { LiveWatch } from "@/lib/types";
import { postHalt } from "@/lib/api";
import { tokenFromUrl } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { Icon } from "@/lib/icons";
import { OctagonX, Play } from "lucide-react";

/**
 * Header RUN / HALT switch — same HALT file as `npm run halt`.
 * Confirm with dash token before toggling (closes all opens on halt).
 */
export function HaltToggle({ watch }: { watch: LiveWatch | null }) {
  const halted = !!watch?.ops?.halted;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const token = tokenFromUrl() ?? "";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirm("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirm("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async () => {
    const action = halted ? "resume" : "halt";
    setBusy(true);
    try {
      const r = await postHalt(action, confirm);
      toast({
        title: action === "halt" ? "Bot halted" : "Bot resumed",
        detail: r.note,
        tone: action === "halt" ? "danger" : "ok",
        kind: "event",
      });
      setConfirm("");
      setOpen(false);
    } catch (e) {
      toast({
        title: action === "halt" ? "Halt failed" : "Resume failed",
        detail: (e as Error).message,
        tone: "danger",
        kind: "fail",
      });
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !!confirm && (!token || confirm === token) && !busy;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          halted
            ? `Halted${watch?.ops?.halt_at ? ` since ${watch.ops.halt_at}` : ""} — click to resume`
            : "Bot running — click to halt (closes all open positions)"
        }
        className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[10px] tracking-widest ${
          halted
            ? "border-danger/70 text-danger"
            : "border-ok/70 text-ok"
        }`}
      >
        <span
          className={`relative h-3 w-5 shrink-0 border ${
            halted ? "border-danger/70 bg-danger/15" : "border-ok/70 bg-ok/15"
          }`}
          aria-hidden
        >
          <span
            className={`absolute top-0.5 h-1.5 w-1.5 ${
              halted ? "right-0.5 bg-danger" : "left-0.5 bg-ok"
            }`}
          />
        </span>
        {halted ? "HALT" : "ON"}
      </button>

      {open ? (
        <div className="absolute top-full left-0 z-40 mt-1.5 w-[16.5rem] border border-grid bg-bg p-3 shadow-lg shadow-black/50">
          <p className="text-[11px] leading-snug text-warn">
            {halted
              ? "Re-enter dash token to resume entries."
              : "Re-enter dash token. Halt closes every open position, then idles."}
          </p>
          <input
            type="password"
            autoComplete="off"
            placeholder="DASH_TOKEN"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) void run();
            }}
            className="mt-2 w-full border border-grid bg-transparent px-2 py-1.5 font-mono text-[12px] text-fg"
            autoFocus
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canSubmit}
              className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-[10px] tracking-wider uppercase disabled:opacity-40 ${
                halted ? "border-ok/70 text-ok" : "border-danger/70 text-danger"
              }`}
              onClick={() => void run()}
            >
              <Icon icon={halted ? Play : OctagonX} size={11} />
              {busy ? "…" : halted ? "Resume" : "Confirm halt"}
            </button>
            <button
              type="button"
              className="border border-grid px-2.5 py-1 text-[10px] tracking-wider text-muted uppercase hover:text-hover"
              onClick={() => { setOpen(false); setConfirm(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
