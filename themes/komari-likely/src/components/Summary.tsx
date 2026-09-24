import { useEffect, useState } from "react"
import { Activity, ArrowDown, ArrowDownUp, ArrowUp, Clock, Gauge, Server } from "lucide-react"

import { Card } from "@/components/ui/card"
import { speedHistory, type Node } from "@/lib/api"
import { bytes, percent, rate } from "@/lib/format"
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

export function Summary({ nodes }: { nodes: Node[] }) {
  const online = nodes.filter((n) => n.online)
  const sum = (pick: (n: Node) => number) => nodes.reduce((total, n) => total + pick(n), 0)

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
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
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
    </div>
  )
}
