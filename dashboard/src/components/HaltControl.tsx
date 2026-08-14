import { useEffect, useRef, useState } from "react";
import type { LiveWatch } from "@/lib/types";
import { postEngine, postHalt } from "@/lib/api";
import { tokenFromUrl } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { Icon } from "@/lib/icons";
import { OctagonX, Play } from "lucide-react";

/**
 * Header engine ON/OFF (soft pause) + separate HALT (close-all) button.
 */
export function EngineControls({ watch }: { watch: LiveWatch | null }) {
  const halted = !!watch?.ops?.halted;
  const paused = !!watch?.ops?.paused;
  const engineOn = !paused && !halted;

  const [haltOpen, setHaltOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"engine" | "halt" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const token = tokenFromUrl() ?? "";

  useEffect(() => {
    if (!haltOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setHaltOpen(false);
        setConfirm("");
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHaltOpen(false);
        setConfirm("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [haltOpen]);

  const toggleEngine = async () => {
    if (halted) {
      toast({
        title: "Still halted",
        detail: "Clear HALT with the red button before turning the engine on.",
        tone: "warn",
        kind: "event",
      });
      return;
    }
    const action = engineOn ? "off" : "on";
    setBusy("engine");
    try {
      const r = await postEngine(action);
      toast({
        title: action === "off" ? "Engine off" : "Engine on",
        detail: r.note,
        tone: action === "off" ? "warn" : "ok",
        kind: "event",
      });
    } catch (e) {
      toast({
        title: "Engine toggle failed",
        detail: (e as Error).message,
        tone: "danger",
        kind: "fail",
      });
    } finally {
      setBusy(null);
    }
  };

  const runHalt = async () => {
    const action = halted ? "resume" : "halt";
    setBusy("halt");
    try {
      const r = await postHalt(action, confirm);
      toast({
        title: action === "halt" ? "HALT requested" : "Halt cleared",
        detail: r.note,
        tone: action === "halt" ? "danger" : "ok",
        kind: "event",
      });
      setConfirm("");
      setHaltOpen(false);
    } catch (e) {
      toast({
        title: action === "halt" ? "Halt failed" : "Resume failed",
        detail: (e as Error).message,
        tone: "danger",
        kind: "fail",
      });
    } finally {
      setBusy(null);
    }
  };

  const canHalt = !!confirm && (!token || confirm === token) && busy !== "halt";

  return (
    <div ref={wrapRef} className="relative flex items-center gap-1.5">
      <button
        type="button"
        disabled={busy === "engine"}
        onClick={() => void toggleEngine()}
        title={
          halted
            ? "Engine locked while HALT is active"
            : engineOn
              ? "Engine ON — click to pause trading (positions stay open)"
              : `Engine OFF${watch?.ops?.pause_at ? ` since ${watch.ops.pause_at}` : ""} — click to resume trading`
        }
        className={`inline-flex items-center gap-1.5 border px-1.5 py-0.5 text-[10px] tracking-widest disabled:opacity-50 ${
          engineOn ? "border-ok/70 text-ok" : "border-warn/70 text-warn"
        }`}
      >
        <span
          className={`relative h-3 w-5 shrink-0 border ${
            engineOn ? "border-ok/70 bg-ok/15" : "border-warn/70 bg-warn/15"
          }`}
          aria-hidden
        >
          <span
            className={`absolute top-0.5 h-1.5 w-1.5 ${
              engineOn ? "left-0.5 bg-ok" : "right-0.5 bg-warn"
            }`}
          />
        </span>
        {engineOn ? "ON" : "OFF"}
      </button>

      <button
        type="button"
        onClick={() => setHaltOpen((v) => !v)}
        title={
          halted
            ? `HALTED${watch?.ops?.halt_at ? ` since ${watch.ops.halt_at}` : ""} — click to clear`
            : "Emergency HALT — closes all open positions, then idles"
        }
        className="inline-flex items-center border border-danger/70 px-1.5 py-0.5 text-[10px] tracking-widest text-danger hover:bg-danger/10"
      >
        {halted ? "RESUME" : "HALT"}
      </button>

      {haltOpen ? (
        <div className="absolute top-full left-0 z-40 mt-1.5 w-[16.5rem] border border-grid bg-bg p-3 shadow-lg shadow-black/50">
          <p className="text-[11px] leading-snug text-warn">
            {halted
              ? "Re-enter dash token to clear HALT and allow trading again."
              : "Re-enter dash token. HALT closes every open position, then idles."}
          </p>
          <input
            type="password"
            autoComplete="off"
            placeholder="DASH_TOKEN"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canHalt) void runHalt();
            }}
            className="mt-2 w-full border border-grid bg-transparent px-2 py-1.5 font-mono text-[12px] text-fg"
            autoFocus
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canHalt}
              className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-[10px] tracking-wider uppercase disabled:opacity-40 ${
                halted ? "border-ok/70 text-ok" : "border-danger/70 text-danger"
              }`}
              onClick={() => void runHalt()}
            >
              <Icon icon={halted ? Play : OctagonX} size={11} />
              {busy === "halt" ? "…" : halted ? "Confirm resume" : "Confirm halt"}
            </button>
            <button
              type="button"
              className="border border-grid px-2.5 py-1 text-[10px] tracking-wider text-muted uppercase hover:text-hover"
              onClick={() => { setHaltOpen(false); setConfirm(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** @deprecated use EngineControls */
export const HaltToggle = EngineControls;
