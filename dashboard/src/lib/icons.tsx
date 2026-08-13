import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  BookOpen,
  CircleAlert,
  CircleDot,
  HandCoins,
  LayoutDashboard,
  LineChart,
  Lock,
  OctagonX,
  PauseCircle,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldAlert,
  SkipForward,
  Microscope,
  TrendingUp,
  Unplug,
  Wallet,
  Zap,
} from "lucide-react";
import type { FeedKind } from "@/lib/activityFeed";
import type { RangeStatus } from "@/components/RangeBar";
import type { TabId } from "@/components/Shell";
import { cn } from "@/lib/utils";

export const tabIcon: Record<TabId, LucideIcon> = {
  overview: LayoutDashboard,
  book: BookOpen,
  analytics: LineChart,
  activity: Activity,
  errors: OctagonX,
  research: Microscope,
  changes: ScrollText,
  settings: Settings,
};

export const feedKindIcon: Record<FeedKind, LucideIcon> = {
  // Cashflow: up/red = SOL out (enter), down/green = SOL in (exit/close).
  entry: ArrowUpFromLine,
  exit: ArrowDownToLine,
  skip: SkipForward,
  fail: OctagonX,
  event: Zap,
  cluster: ShieldAlert,
};

export const rangeStatusIcon: Record<RangeStatus, LucideIcon> = {
  in: CircleDot,
  above: TrendingUp,
  below: ArrowDownToLine,
  out: Ban,
  unknown: CircleAlert,
};

/** Event subtype (claim / rent_reclaim / …) when kind is `event`. */
export function eventGateIcon(gate: string | null | undefined): LucideIcon {
  switch (gate) {
    case "claim": return HandCoins;
    case "profit_lock": return Lock;
    case "rebalance":
    case "rebalance_partial": return RefreshCw;
    case "rent_reclaim": return Wallet;
    case "force_close": return AlertTriangle;
    default: return Zap;
  }
}

export function Icon({
  icon: I,
  className,
  size = 12,
}: {
  icon: LucideIcon;
  className?: string;
  size?: number;
}) {
  return <I size={size} strokeWidth={1.75} className={cn("shrink-0", className)} aria-hidden />;
}

/** Lucide dropped brand icons — compact GitHub mark matching Icon sizing. */
export function GithubMark({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <path d="M12 2C6.477 2 2 6.586 2 12.253c0 4.537 2.865 8.377 6.839 9.73.5.094.683-.222.683-.493 0-.243-.009-.888-.014-1.743-2.782.618-3.369-1.38-3.369-1.38-.455-1.185-1.11-1.5-1.11-1.5-.908-.638.069-.625.069-.625 1.004.072 1.532 1.06 1.532 1.06.892 1.57 2.341 1.116 2.91.854.091-.665.35-1.117.636-1.374-2.221-.26-4.555-1.142-4.555-5.084 0-1.123.39-2.041 1.029-2.76-.103-.26-.446-1.303.098-2.715 0 0 .84-.276 2.75 1.054A9.3 9.3 0 0 1 12 7.05c.85.004 1.705.118 2.504.346 1.909-1.33 2.747-1.054 2.747-1.054.546 1.412.203 2.455.1 2.715.64.719 1.028 1.637 1.028 2.76 0 3.952-2.337 4.821-4.565 5.076.36.318.68.945.68 1.905 0 1.375-.012 2.483-.012 2.82 0 .274.18.592.688.491C19.138 20.627 22 16.787 22 12.253 22 6.586 17.523 2 12 2z" />
    </svg>
  );
}

export { CircleDot, PauseCircle, Unplug, Zap };
