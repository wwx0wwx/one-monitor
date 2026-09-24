import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Flag } from "@/components/Flag"
import { Meter } from "@/components/Meter"
import { OsIcon } from "@/components/OsIcon"
import type { Node } from "@/lib/api"
import { bytes, CYCLES, daysUntil, FOREVER, money, pair, percent, rate, uptime } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Which direction the plan meters, matching the node's traffic_mode. */
export function monthUsage(node: Node): number {
  const { month_rx: rx, month_tx: tx } = node
  switch (node.traffic_mode) {
    case "up":
      return tx
    case "down":
      return rx
    case "max":
      return Math.max(rx, tx)
    default:
      return rx + tx
  }
}

// A node that has reported once has told the hub its shape -- cores, memory,
// disk -- and the hub retains its traffic totals whether connected or not. A node
// that never connected is the only case with nothing to show.
function deployed(node: Node) {
  return node.cpu_cores > 0 || node.mem_total > 0
}

/**
 * The machine's state as a word in the colour that word reads in: green for
 * alive, red for gone, the neutral outline for a machine that never connected,
 * which neither colour describes. How long it has been that way lives beside
 * the renewal in the card's corner instead.
 */
export function Status({ node }: { node: Node }) {
  const tone = node.online
    ? "border-transparent bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200"
    : deployed(node)
      ? "border-transparent bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200"
      : "text-muted-foreground"
  return (
    <Badge variant="outline" className={cn("shrink-0 font-normal", tone)}>
      {node.online ? "在线" : deployed(node) ? "离线" : "未接入"}
    </Badge>
  )
}

/** How long the machine has been up -- or once it stops reporting, how long it
 *  has been gone. Both are durations, and the word out front says which.
 *
 * `emph` is the card's corner: the whole phrase on one line, larger and bold,
 * against the renewal column opposite. */
export function Uptime({ node, emph }: { node: Node; emph?: boolean }) {
  const down = node.last_seen ? Date.now() / 1000 - node.last_seen : 0
  const text = node.online
    ? node.metrics
      ? `在线 ${uptime(node.metrics.uptime)}`
      : "在线"
    : down >= 60
      ? `离线 ${uptime(down)}`
      : "离线"
  return (
    <span className={cn("tnum shrink-0", emph ? "text-sm font-medium" : "text-xs text-muted-foreground")}>
      {text}
    </span>
  )
}

/** The operator's own badges for the machine -- specs, billing, whatever --
 * split on semicolons exactly as they were entered. Shared by the card and the
 * detail page, which own their spacing through `className`.
 *
 * `reserve` holds two rows of badges open on the card whether the operator
 * wrote none, one line or two, so every card stands the same height and no
 * badge is ever cut; the detail page wraps without reservation, because there
 * all of them belong. */
export function Tags({ node, className = "mt-2", reserve }: { node: Node; className?: string; reserve?: boolean }) {
  const tags = node.tag?.split(";").map((t) => t.trim()).filter(Boolean) ?? []
  if (!tags.length && !reserve) return null
  return (
    <div className={`${className} flex flex-wrap gap-1 ${reserve ? "min-h-[38px] content-center" : ""}`}>
      {tags.map((tag) => (
        <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground">
          {tag}
        </Badge>
      ))}
    </div>
  )
}

// Traffic uses the plan's own counting rule, so the bar matches the quota the
// node is billed against.
function trafficFoot(node: Node) {
  return node.traffic_limit > 0
    ? pair(monthUsage(node), node.traffic_limit)
    : `${bytes(monthUsage(node))} / ${FOREVER}`
}

// No date means nothing expires: a permanent host, or one with no renewal set. A
// blank corner asserts neither.
function Expiry({ node }: { node: Node }) {
  const days = daysUntil(node.expires_at)
  if (days === null) return <span className="tnum text-xs text-muted-foreground" title="永不到期">{FOREVER}</span>
  const tone = days < 0 ? "text-red-600" : days <= 7 ? "text-orange-500" : "text-muted-foreground"
  return (
    <span className={cn("tnum text-xs", tone)}>
      {days < 0 ? `已过期 ${-days} 天` : `${days} 天后到期`}
    </span>
  )
}

/** What the machine costs, in the plan's own words for its billing cycle. */
function Price({ node }: { node: Node }) {
  return (
    <span className="tnum text-xs text-muted-foreground">
      {node.price > 0
        ? `${money(node.price, node.currency)} / ${CYCLES[node.billing_cycle] ?? node.billing_cycle}`
        : "免费"}
    </span>
  )
}

export function NodeCard({ node, onOpen }: { node: Node; onOpen: () => void }) {
  const m = node.metrics

  return (
    <Card
      onClick={onOpen}
      // min-w-0: a grid item sizes to its content unless told otherwise, and the
      // name and badges inside do not wrap, so on a phone the card would grow
      // past its column and scroll the page sideways. The truncate inside only
      // takes effect once the card is allowed to be narrower.
      className="min-w-0 cursor-pointer gap-0 p-4 transition-all duration-200 hover:scale-[1.02] hover:shadow-lg"
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <Flag country={node.country} />
            <OsIcon os={node.os} />
            <h3 className="truncate font-medium">{node.name}</h3>
          </div>
          {/* Where the OS line was: the operator's own badges carry the line,
              held mid-way between the name and the numbers. The version and
              codename the mark cannot show stay in its tooltip. */}
          <Tags node={node} className="mt-3" reserve />
        </div>
        {/* State right, identity left, one line each. */}
        <div className="flex shrink-0 items-start">
          <Status node={node} />
        </div>
      </div>

      {/* One layout for both states: a disconnected node still knows its
          cores, memory, disk size and traffic totals, and showing those with
          the live figures blank beats a stretched card with one line in it. */}
      {deployed(node) ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
            {/* The core count belongs beside the word CPU: it is what the
                percentage and the load averages are both measured against. */}
            <Meter
              label={`CPU ${node.cpu_cores} 核`}
              pct={m ? m.cpu : null}
              foot={m ? m.load.map((n) => n.toFixed(2)).join(" ") : "—"}
            />
            <Meter
              label="内存"
              pct={m ? percent(m.mem_used, m.mem_total) : null}
              foot={m ? pair(m.mem_used, m.mem_total) : bytes(node.mem_total)}
            />
            <Meter
              label="硬盘"
              pct={m ? percent(m.disk_used, m.disk_total) : null}
              foot={m ? pair(m.disk_used, m.disk_total) : bytes(node.disk_total)}
            />
            {/* A machine without swap is stating a fact, so its meter says so
                rather than hiding the cell. */}
            <Meter
              label="SWAP"
              pct={m && node.swap_total > 0 ? percent(m.swap_used, m.swap_total) : null}
              foot={node.swap_total > 0 ? (m ? pair(m.swap_used, m.swap_total) : bytes(node.swap_total)) : "未启用"}
            />
            <Meter
              label="流量"
              pct={node.traffic_limit > 0 ? percent(monthUsage(node), node.traffic_limit) : null}
              empty={FOREVER}
              foot={trafficFoot(node)}
            />
            {/* A rate has no ceiling to fill a bar against, so no track: the
                two directions stack under the word, down first, so neither
                truncates in half a card. */}
            <div className="grid min-w-0 grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5 text-xs">
              <span className="text-muted-foreground">网速</span>
              <span className="tnum truncate font-medium">{m ? `↓ ${rate(m.net_rx)}` : "—"}</span>
              {m && (
                <>
                  <span aria-hidden />
                  <span className="tnum truncate text-muted-foreground">↑ {rate(m.net_tx)}</span>
                </>
              )}
            </div>
          </div>

          {/* How long it has run lower left, what it costs and when lower
              right. */}
          <div className="mt-4 flex items-end justify-between gap-3 border-t pt-3">
            <Uptime node={node} emph />
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <Expiry node={node} />
              <Price node={node} />
            </div>
          </div>
        </>
      ) : (
        /* Never connected: nothing to plot, so the card stays short rather than
           padding out to match its neighbours. */
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          还没有接入。在后台生成安装命令并执行一次。
        </p>
      )}
    </Card>
  )
}
