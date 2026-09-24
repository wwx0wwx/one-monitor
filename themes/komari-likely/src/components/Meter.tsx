import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type Props = { label: ReactNode; pct: number | null; foot: ReactNode; empty?: ReactNode }

/** komari's thresholds: green below 60%, orange to 80%, red above. */
function shade(pct: number) {
  if (pct >= 80) return "bg-red-600"
  if (pct >= 60) return "bg-orange-500"
  return "bg-green-600"
}

/**
 * One metric: name and percentage on top, bar in the middle, raw numbers
 * underneath. The bar takes the traffic-light shade komari readers expect, so
 * a machine in trouble reads at a glance without its numbers.
 */
export function Meter({ label, pct, foot, empty = "—" }: Props) {
  // null means the metric has no ceiling to fill, so the bar stays empty rather
  // than reporting 0%. What replaces the percentage depends on the reason:
  // unknown for a node with no metrics, ∞ for a plan with no limit.
  const filled = pct === null ? 0 : Math.min(100, Math.max(0, pct))
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span className="tnum text-xs font-medium">
          {pct === null ? empty : `${filled < 10 ? filled.toFixed(1) : filled.toFixed(0)}%`}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-[width,background-color] duration-500", pct === null ? "bg-foreground" : shade(pct))}
          style={{ width: `${filled}%` }}
        />
      </div>
      <div className="tnum mt-1.5 truncate text-xs text-muted-foreground">{foot}</div>
    </div>
  )
}
