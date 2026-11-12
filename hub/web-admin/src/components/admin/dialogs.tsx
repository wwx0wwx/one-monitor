// The node dialogs: create, edit, billing, register window, install.
import { useEffect, useRef, useState } from "react"
import { Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api, changes, GIB, provisioningSite, trafficCorrection, type Node } from "@/lib/api"
import { CYCLES } from "@/lib/format"

import { ConfirmDialog, copy, Field, TRAFFIC_FIELDS, TRAFFIC_MODES } from "./shared"
import type { Settings } from "./settings"

export function CreateNode({ onClose, onSaved }: {
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return toast.error("请填写服务器名称")
    setSaving(true)
    try {
      await api("/nodes", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() }),
      })
      toast.success("服务器已添加")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>添加服务器</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={save}>
          <Field label="名称">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="香港 · 甲商家" />
          </Field>
          <DialogFooter className="border-t pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={saving}>添加</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function NodeForm({ node, onClose, onSaved }: {
  node: Node
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(node)
  const [limitGib, setLimitGib] = useState(String(node.traffic_limit / GIB || ""))
  const [saving, setSaving] = useState(false)
  const gib = (bytes: number) => String(Number((bytes / GIB).toFixed(3)))
  const [traffic, setTraffic] = useState(() =>
    Object.fromEntries(TRAFFIC_FIELDS.map(([k]) => [k, gib(node[k])])) as Record<string, string>,
  )
  // Compared as entered rather than as bytes: rounding to GB would read as an
  // edit and zero a node that has transferred a few MB.
  const pristine = useRef(traffic)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    if (!form.name.trim()) return toast.error("请填写服务器名称")
    const patch = changes(node, {
      name: form.name.trim(),
      public: form.public,
      remark: form.remark,
      tag: form.tag.trim(),
      group: form.group.trim(),
      traffic_mode: form.traffic_mode,
      traffic_limit: Math.round(Number(limitGib) * GIB),
      traffic_reset_day: Math.min(31, Math.max(1, Math.round(Number(form.traffic_reset_day) || 1))),
    })
    const correction = trafficCorrection(pristine.current, traffic)
    if ([patch.traffic_limit, ...Object.values(correction)].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v < 0))) {
      return toast.error("流量必须是有效的非负数，且不能超出精确计数范围")
    }
    setSaving(true)
    try {
      // The correction belongs to the new reset period, so its day is saved
      // first.
      if (Object.keys(patch).length) {
        await api(`/nodes/${node.id}`, { method: "PUT", body: JSON.stringify(patch) })
      }
      if (Object.keys(correction).length) {
        await api(`/nodes/${node.id}/traffic`, {
          method: "PUT",
          body: JSON.stringify(correction),
        })
      }
      toast.success("服务器设置已保存")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <Field label="名称">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每月流量额度 (GB)" hint="留空或 0 不限">
              <Input type="number" value={limitGib} onChange={(e) => setLimitGib(e.target.value)} placeholder="1024" />
            </Field>
            <Field label="流量计算方式">
              <Select value={form.traffic_mode} onValueChange={(v) => set("traffic_mode", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TRAFFIC_MODES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="每月重置日" hint="1–31。本月流量按新周期重算，总流量不变">
              <Input type="number" min={1} max={31} value={form.traffic_reset_day} onChange={(e) => set("traffic_reset_day", Number(e.target.value))} />
            </Field>
            <Field label="备注" hint="仅管理员可见">
              <Input value={form.remark ?? ""} onChange={(e) => set("remark", e.target.value)} placeholder="商家、用途" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="标签" hint="分号分隔，公开页以徽章展示">
              <Input value={form.tag ?? ""} onChange={(e) => set("tag", e.target.value)} placeholder="dedicated;16v;32g;16T;500MpsUp" />
            </Field>
            <Field label="分组" hint="用于列表筛选，留空不分组">
              <Input value={form.group ?? ""} onChange={(e) => set("group", e.target.value)} placeholder="香港" list="node-groups" />
            </Field>
          </div>
          <details className="rounded-lg border bg-muted/30 px-3 py-2.5">
            <summary className="cursor-pointer text-sm font-medium">流量校正</summary>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              按 GB 填入需要校正的值，未修改的计数器继续正常累计。
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              {TRAFFIC_FIELDS.map(([key, label]) => (
                <Field key={key} label={`${label} (GB)`}>
                  <Input
                    type="number"
                    step="0.001"
                    value={traffic[key]}
                    onChange={(e) => setTraffic((t) => ({ ...t, [key]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </details>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">公开显示</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">关闭后只在管理后台可见</span>
            </span>
            <Switch checked={form.public} onCheckedChange={(v) => set("public", v)} />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            离线通知不再按服务器单独设置，请到「通知」页统一开关。
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BillingForm({ node, onClose, onSaved }: {
  node: Node
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState(node)
  // Text rather than a number: a numeric state cannot represent an empty field,
  // so clearing it would snap back to 0 mid-entry. Empty means free.
  const [price, setPrice] = useState(node.price > 0 ? String(node.price) : "")
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof Node>(k: K, v: Node[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true)
    try {
      await api(`/nodes/${node.id}`, {
        method: "PUT",
        body: JSON.stringify(changes(node, {
          price: Math.max(0, Number(price) || 0),
          currency: form.currency,
          billing_cycle: form.billing_cycle,
          expires_at: form.expires_at || null,
          auto_renew: form.auto_renew,
        })),
      })
      toast.success("续费设置已保存")
      onClose()
      onSaved()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="价格" hint="留空或 0 为免费">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="免费"
              />
            </Field>
            <Field label="货币">
              <Select value={form.currency} onValueChange={(v) => set("currency", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["USD", "CNY", "EUR", "GBP", "JPY"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="付款周期">
              <Select value={form.billing_cycle} onValueChange={(v) => set("billing_cycle", v)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CYCLES).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="到期时间">
              <Input type="date" value={form.expires_at ?? ""} onChange={(e) => set("expires_at", e.target.value)} />
            </Field>
          </div>
          {/* Renewal is per node and off by default: a machine still up past its
              plan may deserve a hand-entered date rather than a silent roll. */}
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">到期自动续期</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                过期后服务器仍在线时，到期日按付款周期整周期顺延，并推送提醒
              </span>
            </span>
            <Switch checked={form.auto_renew} onCheckedChange={(v) => set("auto_renew", v)} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Built here from the token the dialog read on opening: the list and the
// stream frames carry none, and displaying a command is a read rather than an
// action. Reissuing one to display it would take the running agent offline.
export function installCommand(site: string, token: string, seconds: number) {
  site = provisioningSite(site)
  if (!site) return ""
  const args = [`--server ${site}`, `--token ${token}`, `--interval ${seconds}`]
  return `curl -fsSL ${site}/install.sh | sh -s -- ${args.join(" ")}`
}

// One command for a batch of machines. The key belongs to the hub, is valid only
// within the window it opened, and each machine exchanges it for a token of its
// own, so unlike an install command this text is no one's credential and can be
// used directly in a loop.
export function registerCommand(site: string, key: string) {
  site = provisioningSite(site)
  if (!site) return ""
  const args = [`--server ${site}`, `--register ${key}`]
  return `curl -fsSL ${site}/install.sh | sh -s -- ${args.join(" ")}`
}

// The window lives on the hub; this reads it back and counts down, which is also
// what makes an expired one disappear from the panel without interaction.
export function useRegisterWindow() {
  const [key, setKey] = useState("")
  const [until, setUntil] = useState(0)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    api<Settings>("/settings")
      .then((s) => { setKey(String(s.register_key ?? "")); setUntil(Number(s.register_until ?? 0)) })
      .catch(() => {})
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(timer)
  }, [])

  return {
    key,
    left: key === "" ? 0 : Math.max(0, until - now),
    async open() {
      try {
        const w = await api<{ register_key: string; register_until: string }>("/register-window", { method: "POST" })
        setKey(w.register_key)
        setUntil(Number(w.register_until))
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
    async close() {
      try {
        await api("/register-window", { method: "DELETE" })
        setKey("")
        setUntil(0)
        toast.success("注册窗口已关闭")
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
  }
}

export function RegisterDialog({ site, reg, onClose }: {
  site: string
  reg: ReturnType<typeof useRegisterWindow>
  onClose: () => void
}) {
  const command = reg.left > 0 ? registerCommand(site, reg.key) : ""
  const clock = `${Math.floor(reg.left / 60)}:${String(reg.left % 60).padStart(2, "0")}`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>批量添加</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            开一个一小时的注册窗口。期间这条命令在任意机器上跑一次，那台机器就会自己出现在
            列表里，名字取自它的 hostname。命令里没有任何一台机器的凭证，可以直接进循环。
          </p>
          {command ? (
            <div className="space-y-2">
              <Label className="text-sm font-medium">安装命令</Label>
              <pre className="h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed select-all">
                {command}
              </pre>
              <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                <span>
                  <span className="block font-medium">窗口 {clock} 后自动关闭</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    到点自动失效，装完了也可以现在就关
                  </span>
                </span>
                <Button variant="outline" size="sm" onClick={reg.close}>立即关闭</Button>
              </div>
            </div>
          ) : (
            <Button onClick={reg.open}>开启一小时窗口</Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command}>
            <Copy className="size-4" /> 复制
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InstallDialog({ node, site, onClose, onRotated }: {
  node: Node
  site: string
  onClose: () => void
  onRotated: () => void
}) {
  // The list carries no token -- it left every list and stream frame -- so the
  // command's credential is read when the dialog opens. A read, not the
  // reissue: displaying the command must not retire what the running agent
  // holds; the button below does that, deliberately.
  const [token, setToken] = useState("")
  const [interval, setInterval] = useState("1")
  const [rotating, setRotating] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  // The hub relays the agent binary from GitHub behind this prefix. Surfaced
  // here because the moment it matters is exactly this one: installing onto a
  // machine while the hub itself cannot reach github.com.
  const [proxy, setProxy] = useState<string | null>(null)
  const [proxyOn, setProxyOn] = useState(false)
  useEffect(() => {
    api<{ token: string }>(`/nodes/${node.id}/token`)
      .then((t) => setToken(t.token))
      .catch(() => setToken(""))
    api<Settings>("/settings")
      .then((s) => {
        const stored = String(s.github_proxy ?? "")
        setProxy(stored)
        setProxyOn(stored !== "")
      })
      .catch(() => setProxy(""))
  }, [node.id])

  const seconds = Math.min(3600, Math.max(1, Math.round(Number(interval) || 1)))
  const command = token ? installCommand(site, token, seconds) : ""

  // The toggle stores the setting itself: on with an address, or off clearing
  // it. The install command never changes -- the hub relays either way.
  async function toggleProxy(on: boolean, address = proxy ?? "") {
    if (on && !address.trim()) {
      toast.error("请先填写代理地址，例如 https://ghfast.top")
      return
    }
    const next = on ? address.trim() : ""
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ github_proxy: next }) })
      setProxy(next)
      setProxyOn(on)
      toast.success(on ? "已启用 GitHub 代理" : "已改为直连 GitHub")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function rotate() {
    setRotating(true)
    try {
      const fresh = await api<{ token: string }>(`/nodes/${node.id}/token`, { method: "POST" })
      setToken(fresh.token)
      setConfirmRotate(false)
      toast.success("凭证已换发，需用新命令重装")
      onRotated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRotating(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{node.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <Field label="上报间隔（秒）" hint="1–3600，默认 1 秒">
            <Input type="number" min={1} max={3600} value={interval} onChange={(e) => setInterval(e.target.value)} />
          </Field>
          <div className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5">
            <label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
              <span>
                <span className="block font-medium">GitHub 代理</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  agent 二进制由 hub 从 GitHub 中转下载；hub 直连不上 GitHub 时启用
                </span>
              </span>
              <Switch checked={proxyOn} onCheckedChange={(v) => toggleProxy(v)} />
            </label>
            <div className="flex gap-2">
              <Input
                className="text-xs"
                value={proxy ?? ""}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="https://ghfast.top"
              />
              <Button size="sm" variant="outline" disabled={!proxyOn} onClick={() => toggleProxy(true)}>保存</Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-sm font-medium">安装命令</Label>
            <pre className="h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed select-all">
              {/* The token read failed, or the dialog is still reading it;
                  reissuing is the operator's explicit choice below. */}
              {command || "凭证读取中，或不可读取——可换发后显示"}
            </pre>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span>
              <span className="block font-medium">换发凭证</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                旧凭证立即作废，agent 掉线，需用新命令重装
              </span>
            </span>
            <Button variant="outline" size="sm" disabled={rotating} onClick={() => setConfirmRotate(true)}>
              换发
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button onClick={() => copy(command)} disabled={!command}>
            <Copy className="size-4" /> 复制
          </Button>
        </DialogFooter>
      </DialogContent>
      {confirmRotate && (
        <ConfirmDialog
          title={`给「${node.name}」换发凭证？`}
          description="旧凭证立即作废，agent 掉线，必须用新命令重装。仅在凭证可能泄露时使用。"
          confirmLabel="换发凭证"
          busy={rotating}
          onClose={() => setConfirmRotate(false)}
          onConfirm={rotate}
        />
      )}
    </Dialog>
  )
}
