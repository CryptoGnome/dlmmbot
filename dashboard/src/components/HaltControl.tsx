import { useState } from "react";
import type { LiveWatch } from "@/lib/types";
import { postHalt } from "@/lib/api";
import { tokenFromUrl } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { Badge, Panel } from "@/components/ui";
import { Icon } from "@/lib/icons";
import { OctagonX, Play } from "lucide-react";

/** Emergency stop / resume — writes the same HALT file the farmer watches. */
export function HaltControl({ watch }: { watch: LiveWatch | null }) {
  const halted = !!watch?.ops?.halted;
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const token = tokenFromUrl() ?? "";

  const run = async (action: "halt" | "resume") => {
    setBusy(true);
    try {
      const r = await postHalt(action, confirm);
      toast({
        title: action === "halt" ? "HALT requested" : "Resumed",
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

  return (
    <Panel
      title="Bot control"
      right={<Badge tone={halted ? "danger" : "ok"}>{halted ? "HALTED" : "running"}</Badge>}
    >
      <p className="mb-3 text-[11px] text-dim">
        {halted
          ? `Idle since ${watch?.ops?.halt_at ?? "—"}. Resume clears HALT; the farmer picks up on the next tick.`
          : "Halt closes all open positions, then idles (no new entries) until you Resume."}
      </p>
      {!open ? (
        <button
          type="button"
          className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-[11px] tracking-wider uppercase ${
            halted
              ? "border-ok/70 text-ok hover:bg-ok/10"
              : "border-danger/70 text-danger hover:bg-danger/10"
          }`}
          onClick={() => setOpen(true)}
        >
          <Icon icon={halted ? Play : OctagonX} size={12} />
          {halted ? "Resume bot" : "Halt bot"}
        </button>
      ) : (
        <div className="space-y-2 border border-grid p-3">
          <p className="text-[11px] text-warn">
            {halted
              ? "Re-enter your dash token to resume trading."
              : "Re-enter your dash token. This closes every open position."}
          </p>
          <input
            type="password"
            autoComplete="off"
            placeholder="DASH_TOKEN"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full border border-grid bg-transparent px-2 py-1.5 font-mono text-[12px] text-fg"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !confirm || (token ? confirm !== token : false)}
              className={`inline-flex items-center gap-1.5 border px-3 py-1.5 text-[11px] tracking-wider uppercase disabled:opacity-40 ${
                halted ? "border-ok/70 text-ok" : "border-danger/70 text-danger"
              }`}
              onClick={() => void run(halted ? "resume" : "halt")}
            >
              <Icon icon={halted ? Play : OctagonX} size={12} />
              {busy ? "…" : halted ? "Confirm resume" : "Confirm halt"}
            </button>
            <button
              type="button"
              className="border border-grid px-3 py-1.5 text-[11px] tracking-wider text-muted uppercase hover:text-hover"
              onClick={() => { setOpen(false); setConfirm(""); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
