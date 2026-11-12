// The latency monitors page.
import { useEffect, useState } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, type Node, type PingTask } from "@/lib/api"

import { ConfirmDialog, Field } from "./shared"

export function Ping({ nodes }: { nodes: Node[] }) {
  const [tasks, setTasks] = useState<PingTask[]>([])
  const [editing, setEditing] = useState<Partial<PingTask> | null>(null)
  const [deleting, setDeleting] = useState<PingTask | null>(null)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState(false)
  // The server picker starts closed: on a fleet of a hundred the flat checkbox
  // list made this dialog taller than the screen.
  const [pickerOpen, setPickerOpen] = useState(false)

  const load = () => api<{ tasks: PingTask[] }>("/ping-tasks").then((d) => setTasks(d.tasks)).catch(() => {})
  useEffect(() => { load() }, [])

  async function save() {
    if (!editing) return
    if (!editing.name?.trim() || !editing.target?.trim()) return toast.error("请填写名称和目标")
    setSaving(true)
    try {
      await api("/ping-tasks", { method: "POST", body: JSON.stringify(editing) })
      toast.success("已保存，正在下发")
      setEditing(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!deleting) return
    setRemoving(true)
    try {
      await api(`/ping-tasks/${deleting.id}`, { method: "DELETE" })
      toast.success("监控已删除")
      setDeleting(null)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRemoving(false)
    }
  }

  const toggle = (id: number) =>
    setEditing((t) => {
      if (!t) return t
      const nodes = t.nodes ?? []
      return { ...t, nodes: nodes.includes(id) ? nodes.filter((n) => n !== id) : [...nodes, id] }
    })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing({ name: "", target: "", interval: 60, nodes: [] })}>
          <Plus /> 添加监控
        </Button>
      </div>

      <Card className="overflow-x-auto p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[24%]">名称</TableHead>
              <TableHead className="w-[40%]">目标</TableHead>
              <TableHead className="w-[12%]">间隔</TableHead>
              <TableHead className="w-[12%]">服务器</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="tnum text-sm">{t.target}</TableCell>
                <TableCell className="tnum text-sm">{t.interval}s</TableCell>
                <TableCell className="text-sm text-muted-foreground">{t.nodes.length} 台</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(t)} title="编辑监控" aria-label="编辑监控"><Pencil /></Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleting(t)} title="删除监控" aria-label="删除监控">
                    <Trash2 className="text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {tasks.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  还没有延迟监控。每台服务器独立 TCP 连接目标端口并上报耗时。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {editing && (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>{editing.id ? "编辑监控" : "添加监控"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="名称">
                  {/* A new monitor starts empty, so the cursor belongs here;
                      editing an existing one starts with nothing selected. */}
                  <Input autoFocus={!editing.id} value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="浙江移动v4" />
                </Field>
                <Field label="间隔（秒）" hint="5–3600">
                  {/* `|| 60`, as the three other number boxes on this page do:
                      an emptied `type="number"` reads back as "", and Number("")
                      is 0 -- which the hub used to clamp into a 5-second probe on
                      every assigned node. It refuses that now, so this keeps a
                      cleared box from being a round trip to an error. */}
                  <Input type="number" min="5" max="3600" value={editing.interval ?? 60} onChange={(e) => setEditing({ ...editing, interval: Number(e.target.value) || 60 })} />
                </Field>
              </div>
              <Field label="目标地址" hint="host:port">
                <Input value={editing.target ?? ""} onChange={(e) => setEditing({ ...editing, target: e.target.value })} placeholder="112.13.210.86:443" />
              </Field>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-sm font-medium">
                    运行服务器
                    {editing.nodes?.length ? (
                      <span className="ml-1 text-xs text-muted-foreground">已选 {editing.nodes.length} / {nodes.length}</span>
                    ) : null}
                  </Label>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPickerOpen((v) => !v)}>
                    {pickerOpen ? "收起" : "展开"}
                  </Button>
                </div>
                {pickerOpen && (
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border bg-muted/20 p-2">
                    {nodes.map((n) => (
                      <label key={n.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-background">
                        <input type="checkbox" checked={editing.nodes?.includes(n.id) ?? false} onChange={() => toggle(n.id)} className="accent-primary" />
                        {n.name}
                      </label>
                    ))}
                    {nodes.length === 0 && <p className="p-2 text-xs text-muted-foreground">先添加服务器</p>}
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              <Button onClick={save} disabled={saving}>保存</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`删除监控「${deleting.name}」？`}
          description="该监控及其历史延迟记录一并删除，不可恢复。"
          confirmLabel="删除监控"
          busy={removing}
          onClose={() => setDeleting(null)}
          onConfirm={remove}
        />
      )}
    </div>
  )
}
