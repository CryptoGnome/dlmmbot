import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Flash green/red when a live WebSocket-driven number changes. */
export function LiveNum({
  signal,
  className,
  children,
  title,
}: {
  /** Numeric (or string) value used to detect change + direction. */
  signal: number | string | null | undefined;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  const key = signal == null ? "" : String(signal);
  const prev = useRef(key);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    if (prev.current === key) return;
    const a = Number(prev.current);
    const b = Number(key);
    let dir: "up" | "down" | null = null;
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      dir = b > a ? "up" : "down";
    } else if (prev.current !== "" && key !== "" && prev.current !== key) {
      dir = "up";
    }
    prev.current = key;
    if (!dir) return;
    setFlash(dir);
    const t = window.setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(t);
  }, [key]);

  return (
    <span
      title={title}
      className={cn(
        "inline-block transition-[background-color,transform]",
        flash === "up" && "live-flash-up",
        flash === "down" && "live-flash-down",
        className,
      )}
    >
      {children}
    </span>
  );
}
