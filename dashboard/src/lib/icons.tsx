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
  research: Microscope,
  settings: Settings,
};

export const feedKindIcon: Record<FeedKind, LucideIcon> = {
  entry: ArrowDownToLine,
  exit: ArrowUpFromLine,
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

export { CircleDot, PauseCircle, Unplug, Zap };
