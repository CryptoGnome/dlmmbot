import { cn } from "@/lib/utils";

/** BidAsk-under LP mark: purple SOL bins, green price tick, blue token bins. */
export function BrandLogo({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <rect width="32" height="32" rx="6" fill="#141414" />
      <rect x="4" y="18" width="2.5" height="7" rx="0.4" fill="#B56BFF" />
      <rect x="7.5" y="15" width="2.5" height="10" rx="0.4" fill="#B56BFF" />
      <rect x="11" y="12" width="2.5" height="13" rx="0.4" fill="#B56BFF" />
      <rect x="14.5" y="10" width="2.5" height="15" rx="0.4" fill="#B56BFF" />
      <rect x="18" y="8" width="2.5" height="17" rx="0.4" fill="#B56BFF" />
      <rect x="21.25" y="7" width="1" height="18" rx="0.5" fill="#00FF85" />
      <rect x="23" y="11" width="2.5" height="14" rx="0.4" fill="#1E90FF" />
      <rect x="26.5" y="14" width="2.5" height="11" rx="0.4" fill="#1E90FF" />
    </svg>
  );
}
