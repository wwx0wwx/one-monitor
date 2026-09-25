import { useEffect, useState } from "react"
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Clock, Coins, Gauge, Server } from "lucide-react"

import { Card } from "@/components/ui/card"
import { speedHistory, type Node } from "@/lib/api"
import { bytes, CYCLE_DAYS, daysUntil, percent, rate } from "@/lib/format"
import { cnyPer, useCnyTable } from "@/lib/fx"
import { cn } from "@/lib/utils"

function Tile({ icon: Icon, label, className, children }: {
  icon: typeof Server; label: string; className?: string; children: React.ReactNode
}) {
  return (
    <Card className={cn("gap-0 p-3", className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      {children}
    </Card>
  )
}

/** The clock komari's summary opens with, ticking once a second. */
function ClockFace() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <div className="tnum mt-1 text-xl font-semibold">{now.toLocaleString("zh-CN", { hour12: false })}</div>
}

/**
 * In and out side by side, the form every traffic figure on this page takes.
 * Stacked below sm, where two tiles share a phone's width and "23.3 MB" has
 * roughly 70px available.
 */
function Flow({ down, up, className }: { down: string; up: string; className?: string }) {
  return (
    <div className={cn("tnum grid grid-cols-1 gap-x-2 sm:grid-cols-2", className)}>
      <span className="inline-flex items-center gap-1">
        <ArrowDown className="size-3 shrink-0 text-muted-foreground" />
        {down}
      </span>
      <span className="inline-flex items-center gap-1">
        <ArrowUp className="size-3 shrink-0 text-muted-foreground" />
        {up}
      </span>
    </div>
  )
}

/**
 * A bare polyline with no axes or tooltips: at this size only the shape is
 * legible, and recharts would bring a full chart's machinery for it. Series share
 * one scale so the two throughput lines remain comparable.
 */
function Spark({ series }: { series: { values: number[]; className: string }[] }) {
  const top = Math.max(...series.flatMap((s) => s.values), 1)
  const width = Math.max(...series.map((s) => s.values.length), 2) - 1
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      {series.map((s, i) => (
        <polyline
          key={i}
          className={s.className}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
          points={s.values.map((v, x) => `${(x / width) * 100},${23 - (v / top) * 22}`).join(" ")}
        />
      ))}
    </svg>
  )
}

export function Summary({ nodes, showCost }: { nodes: Node[]; showCost?: boolean }) {
  const online = nodes.filter((n) => n.online)
  const sum = (pick: (n: Node) => number) => nodes.reduce((total, n) => total + pick(n), 0)

  // The fleet's running bill, for the operator's eyes only: each priced cycle
  // spread over its own days and converted at the day's table, plus what the
  // machines still hold -- price times the days left on it, the detail page's
  // 剩余价值 summed. A machine with no expiry holds an unbounded amount, which
  // cannot join a sum and is left out of it. A currency the table does not
  // list is skipped rather than guessed at; ≈ marks a total that crossed a
  // rate to get here.
  const table = useCnyTable()
  const bill = nodes.filter((n) => n.price > 0 && CYCLE_DAYS[n.billing_cycle])
  const cost = (() => {
    if (!table) return table === undefined ? undefined : null
    let daily = 0
    let value = 0
    let approx = false
    let known = 0
    for (const n of bill) {
      const fx = cnyPer(n.currency, table)
      if (fx === null) continue
      if (n.currency !== "CNY") approx = true
      daily += (n.price * fx) / CYCLE_DAYS[n.billing_cycle]
      const days = daysUntil(n.expires_at)
      if (days !== null) value += (n.price * fx * Math.max(0, days)) / CYCLE_DAYS[n.billing_cycle]
      known++
    }
    return { daily, value, approx, known }
  })()

  // The busiest node rather than the average: one machine at 95% is what matters,
  // and a fleet of idle ones would average it away.
  const busiest = online.reduce<Node | null>(
    (top, n) => (n.metrics && (!top || n.metrics.cpu > top.metrics!.cpu) ? n : top),
    null,
  )
  const cpu = busiest?.metrics?.cpu ?? 0
  // The same push produced `nodes` and this sample, so the figure above the line
  // is that line's last point.
  const now = speedHistory.at(-1) ?? { rx: 0, tx: 0 }

  return (
    <div className={cn("grid grid-cols-2 gap-3", showCost ? "lg:grid-cols-6" : "lg:grid-cols-5")}>
      {/* Full width on a phone: the row it opens would otherwise pair a clock
          with half a grid and leave the last tile alone below. */}
      <Tile icon={Clock} label="当前时间" className="col-span-2 lg:col-span-1">
        <ClockFace />
      </Tile>
      <Tile icon={Server} label="服务器">
        <div className="tnum mt-1 text-xl font-semibold">
          {online.length} / {nodes.length}
        </div>
        <div className="mt-auto pt-1 text-xs text-muted-foreground">
          {nodes.length - online.length > 0 ? `${nodes.length - online.length} 个离线` : "全部在线"}
        </div>
      </Tile>

      <Tile icon={Activity} label="最忙服务器">
        {/* What "busiest" meant, spread two to a row like the traffic tile --
            the two boards, then the disk and the wire (down and up summed) --
            then who it was. */}
        {busiest?.metrics ? (
          <div className="tnum mt-1 grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
            <span>CPU {busiest.metrics.cpu.toFixed(0)}%</span>
            <span>内存 {percent(busiest.metrics.mem_used, busiest.mem_total).toFixed(0)}%</span>
            <span>磁盘 {percent(busiest.metrics.disk_used, busiest.disk_total).toFixed(0)}%</span>
            <span>↑↓{rate(busiest.metrics.net_rx + busiest.metrics.net_tx).replace(" ", "")}</span>
          </div>
        ) : (
          <div className="mt-1 text-xs text-muted-foreground">无在线服务器</div>
        )}
        <div className={cn("mt-auto truncate pt-1 text-xs", cpu >= 85 ? "font-medium text-foreground" : "text-muted-foreground")}>
          {busiest?.name ?? "—"}
        </div>
      </Tile>

      <Tile icon={ArrowDownUp} label="今日流量">
        <Flow
          down={bytes(sum((n) => n.day_rx))}
          up={bytes(sum((n) => n.day_tx))}
          className="mt-1 text-sm font-semibold"
        />
        <div className="mt-2 text-xs text-muted-foreground">总流量</div>
        <Flow down={bytes(sum((n) => n.total_rx))} up={bytes(sum((n) => n.total_tx))} className="mt-0.5 text-sm" />
      </Tile>

      <Tile icon={Gauge} label="实时网速">
        <Flow down={rate(now.rx)} up={rate(now.tx)} className="mt-1 text-sm font-semibold" />
        <div className="mt-auto pt-1">
          <Spark
            series={[
              { values: speedHistory.map((s) => s.rx), className: "text-foreground" },
              { values: speedHistory.map((s) => s.tx), className: "text-muted-foreground" },
            ]}
          />
        </div>
      </Tile>

      {/* The money tile follows the operator's call: signed-in always, the
          public page only when they chose to share it. */}
      {showCost && (
        <Tile icon={Coins} label="每日成本" className="col-span-2 lg:col-span-1">
          <div className="tnum mt-1 text-xl font-semibold">
            {cost === undefined || cost === null || cost.known === 0
              ? cost === undefined ? "…" : "—"
              : `${cost.approx ? "≈¥" : "¥"}${cost.daily.toFixed(2)}`}
          </div>
          {cost && cost.known > 0 && (
            <div className="tnum mt-auto pt-1 text-xs">
              总价值 {cost.approx ? "≈" : ""}¥{cost.value.toFixed(2)}
            </div>
          )}
        </Tile>
      )}
    </div>
  )
}
