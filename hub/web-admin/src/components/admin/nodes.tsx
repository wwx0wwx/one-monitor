// The server list: drag and keyboard ordering, the row actions.
import { useRef, useState } from "react"
import { CalendarClock, ChevronDown, ChevronUp, Download, GripVertical, Pencil, Plus, Server, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type Node } from "@/lib/api"
import { moveIds, visibleNeighbour } from "@/lib/order"
import { bytes, FOREVER, money, monthUsage, uptime } from "@/lib/format"

import { Addresses, ConfirmDialog, animate } from "./shared"
import { BillingForm, CreateNode, InstallDialog, NodeForm, RegisterDialog, useRegisterWindow } from "./dialogs"
import { useSettings } from "./settings"

export function Nodes({ nodes, refresh, site, canProvision, go }: {
  nodes: Node[]
  refresh: () => void
  site: string
  canProvision: boolean
  /** The section nav's own router, so the banner below can point elsewhere. */
  go: (to: string) => void
}) {
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Node | null>(null)
  const [billing, setBilling] = useState<Node | null>(null)
  const [installing, setInstalling] = useState<Node | null>(null)
  const [registering, setRegistering] = useState(false)
  const reg = useRegisterWindow()
  // The one settings read this page makes: whether two-step login is on. Read
  // from /settings like the security page itself, so the banner agrees with the
  // page it sends the operator to.
  const { s: settings } = useSettings()
  // Dismissed, not "done": the banner must survive reloads until it is either
  // acted on or explicitly closed, but not nag across devices. The storage
  // calls can throw (privacy modes, storage disabled); degrading to "not
  // dismissed" costs one extra banner, a thrown boot costs the whole panel.
  const [bannerOff, setBannerOff] = useState(() => {
    try {
      return localStorage.getItem("security-banner-dismissed") === "1"
    } catch {
      return false
    }
  })
  const [deleting, setDeleting] = useState<Node | null>(null)
  const [removing, setRemoving] = useState(false)
  // The reorder preview: `ids` is the order this session wants, `appliesTo`
  // the stream orders it is still valid against. It is a preview and nothing
  // more -- it never outlives its session, which is why the validity is
  // derived here rather than the ids cleared at some picked moment:
  const [manualOrder, setManualOrder] = useState<{ ids: number[]; appliesTo: string[] } | null>(null)
  const [query, setQuery] = useState("")
  const [group, setGroup] = useState("")
  const [dragging, setDragging] = useState<number | null>(null)
  const orderBeforeDrag = useRef<number[]>([])
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const streamIds = nodes.map((n) => n.id).join()
  // The preview applies while the stream still shows an order this session has
  // already displaced (the stream as it stood when the drag or the first
  // keyboard move began, and every saved-but-not-yet-echoed order in a chain
  // of moves -- the echo of move one must not wipe the preview of move two),
  // or the preview itself, which is the echo arriving (the two display the
  // same rows, so retiring then is invisible). Any other stream order -- a
  // node added or removed, another tab's reorder -- outranks it. That is what
  // keeps the list following the stream without a reload, where keeping the
  // ids forever would freeze the panel at its last drag; and clearing them
  // "right after the save" instead would snap the rows back to the pre-save
  // order for the frames the echo has not filled yet.
  const preview =
    manualOrder && (manualOrder.appliesTo.includes(streamIds) || manualOrder.ids.join() === streamIds)
      ? manualOrder.ids
      : []
  const orderedIds = new Set(preview)
  const order = [
    ...preview.map((id) => byId.get(id)).filter((node): node is Node => Boolean(node)),
    ...nodes.filter((node) => !orderedIds.has(node.id)),
  ]
  // Groups exist only as they are used; the filter offers what the fleet has.
  const groups = [...new Set(nodes.map((n) => n.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  // Name and address, the two things a row is looked up by. `order` itself stays
  // whole, because the order sent on drop is the order of every node.
  const needle = query.trim().toLowerCase()
  const visible = order
    .filter((n) => !group || n.group === group)
    .filter((n) => !needle || [n.name, n.ip, n.ipv4, n.ipv6].some((v) => v?.toLowerCase().includes(needle)))

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/nodes/${deleting.id}`, { method: "DELETE" })
      toast.success("已删除")
      setDeleting(null)
      refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  // Rows are displaced while the pointer is down; the order is saved on drop.
  // The splice itself lives in `moveIds`, tested there for exactly the
  // filtered-view-against-full-order mistake this table once made; callers
  // hand it two indices that both belong to `order`.
  function move(from: number, to: number) {
    const ids = moveIds(order.map((node) => node.id), from, to)
    if (!ids) return
    animate(() =>
      setManualOrder((old) => ({
        ids,
        // A move built on a previous one inherits its ancestry: the chain of
        // orders this session has already displaced, plus the stream as it
        // stood before the first move.
        appliesTo: old ? [old.ids.join(), ...old.appliesTo] : [streamIds],
      })),
    )
    return ids
  }

  // Dropped outside the table or cancelled with Escape: the order is restored
  // to what was on screen when the drag began -- the stream's own order, or a
  // keyboard move's preview still waiting for its echo.
  function cancel() {
    setDragging(null)
    const rollback = orderBeforeDrag.current
    animate(() => setManualOrder(rollback.length ? { ids: rollback, appliesTo: [streamIds] } : null))
  }

  function save(ids: number[]) {
    setDragging(null)
    const rollback = orderBeforeDrag.current
    if (!rollback.length || ids.join() === rollback.join()) return
    orderBeforeDrag.current = ids
    api("/nodes/order", { method: "PUT", body: JSON.stringify({ ids }) }).then(refresh, (e: Error) => {
      // The stream still holds the pre-save order (the save failed), so the
      // rollback previews against exactly that.
      animate(() => setManualOrder({ ids: rollback, appliesTo: [streamIds] }))
      toast.error(e.message)
    })
  }

  // Both reorder grips -- the arrow keys on the drag handle and the up/down
  // buttons touch screens get, since a finger has no hover to drag by --
  // travel the same path: the neighbouring row the operator can SEE, not the
  // full list's neighbour. Under a group filter that neighbour may be a hidden
  // row of another group, and swapping with it changes nothing on the screen:
  // a dead key, until it is pressed enough times to cross every hidden row.
  // Both ends land in `order`.
  function shift(node: Node, delta: -1 | 1) {
    const step = visibleNeighbour(order, visible, node.id, delta)
    if (!step) return
    orderBeforeDrag.current = order.map((n) => n.id)
    const ids = move(step.from, step.to)
    if (ids) save(ids)
  }

  return (
    <div className="space-y-4">
      {/* The first-login nudge: a fresh hub has password-only login and often
          the initial password still in place. Shown only while that is actually
          true -- once totp_set reports bound, the banner goes without a
          dismissal needed. */}
      {settings && settings.totp_set !== true && !bannerOff && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
          <span>建议到「安全」开启两步验证，如果还在用初始密码请先修改</span>
          <span className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => go("/admin/security")}>去开启</Button>
            <Button
              size="icon"
              variant="ghost"
              title="关闭提醒"
              aria-label="关闭两步验证提醒"
              onClick={() => {
                try {
                  localStorage.setItem("security-banner-dismissed", "1")
                } catch {
                  // Unwritable storage only means the dismissal is not
                  // remembered past this visit; the page state moves on.
                }
                setBannerOff(true)
              }}
            >
              <X />
            </Button>
          </span>
        </div>
      )}
      {!canProvision && <p className="text-sm text-muted-foreground">请通过 HTTPS 域名访问面板后添加或安装服务器。</p>}
      <datalist id="node-groups">
        {groups.map((g) => <option key={g} value={g} />)}
      </datalist>
      {/* A group filter, offered only when groups exist: a fleet of one group
          needs no chips. */}
      {groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setGroup("")}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${group === "" ? "border-primary bg-secondary font-medium" : "text-muted-foreground hover:bg-muted"}`}
          >
            全部 {nodes.length}
          </button>
          {groups.map((g) => (
            <button
              key={g}
              onClick={() => setGroup(g === group ? "" : g)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${g === group ? "border-primary bg-secondary font-medium" : "text-muted-foreground hover:bg-muted"}`}
            >
              {g} {nodes.filter((n) => n.group === g).length}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Input
          className="mr-auto w-full sm:w-64"
          placeholder="搜索名称或地址"
          aria-label="搜索服务器"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {/* An open window is visible from the list itself, so nobody has to
            remember they left one open. */}
        <Button variant="outline" disabled={!canProvision} onClick={() => setRegistering(true)}>
          <Server /> 批量添加{reg.left > 0 && ` · ${Math.ceil(reg.left / 60)} 分`}
        </Button>
        <Button disabled={!canProvision} onClick={() => setCreating(true)}>
          <Plus /> 添加服务器
        </Button>
      </div>

      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            {/* Percentages, or the address column swallows every spare pixel
                and pushes status across the table. */}
            <TableRow>
              <TableHead className="w-[20%]">名称</TableHead>
              <TableHead className="w-[22%]">IP</TableHead>
              <TableHead className="w-[12%]">状态</TableHead>
              <TableHead className="w-[16%]">流量</TableHead>
              <TableHead className="w-[10%]">价格</TableHead>
              <TableHead className="w-[12%]">到期</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((n) => (
              <TableRow
                key={n.id}
                style={{ viewTransitionName: `node-${n.id}` }}
                data-dragging={dragging === n.id || undefined}
                className="transition-opacity data-[dragging]:opacity-40"
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move" }}
                onDragEnter={() =>
                  dragging !== null &&
                  move(order.findIndex((node) => node.id === dragging), order.findIndex((node) => node.id === n.id))
                }
                onDrop={(e) => { e.preventDefault(); save(order.map((node) => node.id)) }}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      draggable={!needle}
                      // Both indices below are positions in the full `order`,
                      // never in the filtered `visible` list the rows render
                      // from: a group capsule or a search leaves the two out of
                      // step, and an index from one spliced into the other
                      // moves whatever happens to sit there -- a hidden node,
                      // typically -- and saves that as the new order.
                      disabled={!!needle}
                      className="cursor-grab touch-none rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                      title={needle ? "清空搜索后可拖动排序" : "拖动排序"}
                      aria-label={`拖动 ${n.name} 排序`}
                      onDragStart={(e) => {
                        orderBeforeDrag.current = order.map((node) => node.id)
                        setDragging(n.id)
                        e.dataTransfer.effectAllowed = "move"
                        // Firefox refuses to start a drag without a payload.
                        e.dataTransfer.setData("text/plain", String(n.id))
                      }}
                      onDragEnd={(e) => (e.dataTransfer.dropEffect === "none" ? cancel() : save(order.map((node) => node.id)))}
                      onKeyDown={(e) => {
                        const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
                        if (!delta) return
                        e.preventDefault()
                        shift(n, delta)
                      }}
                    >
                      <GripVertical className="size-4" />
                    </button>
                    <div className="min-w-0 font-medium">{n.name}</div>
                    {n.country && (
                      <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                        {n.country}
                      </Badge>
                    )}
                  </div>
                </TableCell>
                {/* Addresses live only here, never on the public page. */}
                <TableCell>
                  <Addresses node={n} />
                </TableCell>
                <TableCell>
                  <Badge variant={n.online ? "default" : "secondary"} className="font-normal">
                    {n.online ? "在线" : "离线"}
                  </Badge>
                  {!n.public && <Badge variant="outline" className="ml-1 font-normal">不公开</Badge>}
                  {/* Under the badge, not inside it: the column is a tenth of
                      the table and the three do not share one line. */}
                  {!n.online && n.last_seen > 0 && Date.now() / 1000 - n.last_seen >= 60 && (
                    <div className="tnum mt-1 text-xs text-muted-foreground">
                      {uptime(Date.now() / 1000 - n.last_seen)}
                    </div>
                  )}
                </TableCell>
                {/* Counted by the node's own billing rule, as on the public
                    page. */}
                <TableCell className="tnum text-sm">
                  {bytes(monthUsage(n))}
                  <span className="text-muted-foreground">
                    {" / "}{n.traffic_limit > 0 ? bytes(n.traffic_limit) : FOREVER}
                  </span>
                </TableCell>
                <TableCell className="tnum text-sm">
                  {n.price > 0 ? money(n.price, n.currency) : "免费"}
                </TableCell>
                <TableCell className="text-sm">{n.expires_at || FOREVER}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {/* Reordering without a drag: touch screens have no reliable
                      one (long-press fights the system gestures) and the
                      keyboard arrows need the focus on the grip first. Same
                      move+save path, disabled at the visible ends. */}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="上移"
                    aria-label={`上移 ${n.name}`}
                    disabled={!visibleNeighbour(order, visible, n.id, -1)}
                    onClick={() => shift(n, -1)}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="下移"
                    aria-label={`下移 ${n.name}`}
                    disabled={!visibleNeighbour(order, visible, n.id, 1)}
                    onClick={() => shift(n, 1)}
                  >
                    <ChevronDown />
                  </Button>
                  <Button variant="ghost" size="icon" disabled={!canProvision} onClick={() => setInstalling(n)} title="安装 Agent" aria-label="安装 Agent">
                    <Download />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setEditing(n)} title="编辑服务器" aria-label="编辑服务器">
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setBilling(n)} title="续费设置" aria-label="续费设置">
                    <CalendarClock />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(n)} title="删除服务器" aria-label="删除服务器">
                    <Trash2 className="text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {nodes.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  还没有服务器，右上角添加
                </TableCell>
              </TableRow>
            )}
            {needle && nodes.length > 0 && !visible.length && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  没有匹配的服务器
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {creating && (
        <CreateNode
          onClose={() => setCreating(false)}
          onSaved={refresh}
        />
      )}
      {editing && (
        <NodeForm
          node={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {billing && (
        <BillingForm node={billing} onClose={() => setBilling(null)} onSaved={refresh} />
      )}
      {registering && <RegisterDialog site={site} reg={reg} onClose={() => { setRegistering(false); refresh() }} />}

      {installing && (
        <InstallDialog
          node={installing}
          site={site}
          onClose={() => setInstalling(null)}
          onRotated={refresh}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`删除服务器「${deleting.name}」？`}
          description="历史指标、流量记录和凭证一并删除，不可恢复。"
          confirmLabel="删除服务器"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}
