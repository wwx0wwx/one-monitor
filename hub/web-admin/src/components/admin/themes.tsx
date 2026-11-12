// The theme page: upload, switch, update from GitHub.
import { useEffect, useRef, useState } from "react"
import { RefreshCw, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { api, upload } from "@/lib/api"

import { ConfirmDialog } from "./shared"
import type { Settings } from "./settings"

export type Theme = {
  name: string
  short: string
  description: string
  version: string
  author: string
  url: string
  selected: boolean
  // 内置主题在二进制里，没有目录可删。装上一份同名的会顶替它，那一份就是普通
  // 主题，删掉之后内置的重新顶上。
  builtin: boolean
}

export function Themes() {
  const [themes, setThemes] = useState<Theme[] | null>(null)
  const [busy, setBusy] = useState("")
  const [doomed, setDoomed] = useState<Theme | null>(null)
  const [zoomed, setZoomed] = useState<Theme | null>(null)
  const picker = useRef<HTMLInputElement>(null)

  const load = () =>
    api<{ themes: Theme[] }>("/themes").then((data) => setThemes(data.themes)).catch(() => setThemes([]))
  useEffect(() => { load() }, [])

  // 站点级的状态页背景：存在设置键里，所有访客看到同一张图。链接和开关在这里，
  // 透明度、模糊、铺满这些观感细节在状态页右上角的「主题设置」（需登录）。
  const [bg, setBg] = useState({ enabled: "off", desktop: "", mobile: "" })
  useEffect(() => {
    api<Settings>("/settings")
      .then((s) =>
        setBg({
          enabled: s.bg_enabled === "on" ? "on" : "off",
          desktop: String(s.bg_desktop ?? ""),
          mobile: String(s.bg_mobile ?? ""),
        }),
      )
      .catch(() => {})
  }, [])

  async function saveBg(patch: Partial<typeof bg>) {
    setBg((old) => ({ ...old, ...patch }))
    const body: Record<string, string> = {}
    if (patch.enabled !== undefined) body.bg_enabled = patch.enabled
    if (patch.desktop !== undefined) body.bg_desktop = patch.desktop
    if (patch.mobile !== undefined) body.bg_mobile = patch.mobile
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(body) })
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function select(short: string) {
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify({ theme: short }) })
      setThemes((old) => old?.map((theme) => ({ ...theme, selected: theme.short === short })) ?? old)
      toast.success("主题已切换")
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function install(file: File) {
    setBusy("upload")
    try {
      const { theme } = await upload<{ theme: Theme }>("/themes", file)
      // The hub reads a theme from disk on every request, so it is already live;
      // reloading the list only brings this page up to date.
      toast.success(`已安装 ${theme.name} ${theme.version}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  // Only a theme whose manifest names a GitHub repository has a source to update
  // from; the hub refuses anything else, and this merely hides the button.
  const updatable = (theme: Theme) => theme.url.startsWith("https://github.com/")

  async function update(theme: Theme) {
    setBusy(`update:${theme.short}`)
    try {
      const { updated, version } = await api<{ updated: boolean; version: string }>(
        `/themes/${theme.short}/update`,
        { method: "POST" },
      )
      toast.success(updated ? `${theme.name} 已更新到 ${version}` : `${theme.name} 已是最新版本 ${version}`)
      if (updated) load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
    }
  }

  async function remove(theme: Theme) {
    setBusy("delete")
    try {
      await api(`/themes/${theme.short}`, { method: "DELETE" })
      toast.success(`已删除 ${theme.name}`)
      load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy("")
      setDoomed(null)
    }
  }

  if (!themes) return null
  return (
    <div className="space-y-4">
      <Card className="gap-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">背景图</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              状态页整页背景，对全部访客生效。图床直链（必须 https://），桌面与移动可各设一张，缺一张时两端共用。
              <br />
              透明度、模糊、铺满方式在状态页右上角的「主题设置」里调整（需登录）。
            </p>
          </div>
          <Switch
            checked={bg.enabled === "on"}
            onCheckedChange={(on) => saveBg({ enabled: on ? "on" : "off" })}
            aria-label="背景图开关"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">桌面版链接</Label>
            {/* key 随设置刷新，未保存的草稿在重新载入时让位 */}
            <Input
              key={bg.desktop}
              defaultValue={bg.desktop}
              placeholder="https://…"
              onBlur={(e) => {
                const next = e.currentTarget.value.trim()
                if (next !== bg.desktop) saveBg({ desktop: next })
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">移动版链接</Label>
            <Input
              key={bg.mobile}
              defaultValue={bg.mobile}
              placeholder="https://…"
              onBlur={(e) => {
                const next = e.currentTarget.value.trim()
                if (next !== bg.mobile) saveBg({ mobile: next })
              }}
            />
          </div>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">安装主题</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            上传主题作者发布的 <code>theme.tar.gz</code>，同名主题整体替换。
            <br />
            主题的 <code>url</code> 指向 GitHub 仓库时，卡片上的 <RefreshCw className="inline size-3" /> 从它最新的
            release 取 <code>theme.tar.gz</code>，版本没变就不下载。
            <br />
            主题代码在访客浏览器中执行，请只安装可信来源。
          </p>
        </div>
        <div>
          <Button size="sm" disabled={!!busy} onClick={() => picker.current?.click()}>
            <Upload /> {busy === "upload" ? "安装中…" : "上传主题包"}
          </Button>
          <input
            ref={picker}
            type="file"
            accept=".gz,.tgz,application/gzip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ""
              if (file) install(file)
            }}
          />
        </div>
      </Card>

      {/* items-start：有预览图和没有的卡片不该为了等高而留白 */}
      <div className="grid items-start gap-3 sm:grid-cols-2">
        {themes.map((theme) => (
          <Card key={theme.short} className="gap-4 p-5">
            {/* 主题包里可选的 preview.png，所以后端不用告诉前端有没有这张图：
                没有就是 404，图一直不显示。hidden 挂在 <a> 上而不是 <img> 上——
                隐藏的是整个链接，否则卡片里留着一个高度为 0 却照样吃 gap-4 的空
                链接。必须从 hidden 开始：带边框的 aspect-video 空盒子会在响应回
                来之前就画出来，闪一下再消失。
                缩略图被压到卡片那点宽度，比例不是 16:9 的还会被 object-cover
                裁掉边，所以图本身要能点开看原尺寸——就地开一个对话框，不跳走。 */}
            <button
              type="button"
              title="查看完整预览图"
              hidden
              className="cursor-zoom-in"
              onClick={() => setZoomed(theme)}
            >
              <img
                src={`/api/themes/${theme.short}/preview`}
                alt={`${theme.name} 预览图`}
                onLoad={(e) => { e.currentTarget.parentElement!.hidden = false }}
                className="aspect-video w-full rounded-md border object-cover object-top"
              />
            </button>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{theme.name}</h3>
                  {theme.selected && <Badge>当前</Badge>}
                  {theme.builtin && <Badge variant="secondary" className="font-normal">内置</Badge>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{theme.description}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant={theme.selected ? "secondary" : "default"} disabled={theme.selected} onClick={() => select(theme.short)}>
                  {theme.selected ? "使用中" : "使用"}
                </Button>
                {updatable(theme) && (
                  <Button
                    size="icon"
                    variant="ghost"
                    title="从 GitHub 更新"
                    disabled={!!busy}
                    onClick={() => update(theme)}
                  >
                    <RefreshCw className={busy === `update:${theme.short}` ? "animate-spin" : ""} />
                  </Button>
                )}
                {/* The built-in theme is served from the binary and has no
                    directory to delete -- it is also the fallback everything
                    else lands on. */}
                {!theme.builtin && (
                  <Button size="icon" variant="ghost" disabled={!!busy} onClick={() => setDoomed(theme)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {theme.author} · {theme.version}
              {theme.url && <> · <a className="hover:underline" href={theme.url} target="_blank" rel="noreferrer">源码</a></>}
            </p>
          </Card>
        ))}
      </div>

      {/* 原图，不是卡片上那张裁过的：宽度给到 4xl，高度让 80vh 兜住，
          object-contain 保证整张都在框里而不是被切一刀。 */}
      {zoomed && (
        <Dialog open onOpenChange={(open) => !open && setZoomed(null)}>
          <DialogContent className="sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle>{zoomed.name} 预览图</DialogTitle>
              <DialogDescription>{zoomed.author} · {zoomed.version}</DialogDescription>
            </DialogHeader>
            <img
              src={`/api/themes/${zoomed.short}/preview`}
              alt={`${zoomed.name} 预览图`}
              className="max-h-[80vh] w-full rounded-md border object-contain"
            />
          </DialogContent>
        </Dialog>
      )}

      {doomed && (
        <ConfirmDialog
          title={`删除 ${doomed.name}？`}
          description={
            doomed.short === "default"
              ? "装上的这份会从磁盘上删掉，公开页回到 hub 内置的那份默认主题。"
              : doomed.selected
                ? "这是当前使用的主题，删除后公开页会回到内置的默认主题。"
                : "主题目录会从磁盘上删掉，重新上传主题包可以装回来。"
          }
          confirmLabel="删除"
          busy={!!busy}
          onClose={() => setDoomed(null)}
          onConfirm={() => remove(doomed)}
        />
      )}
    </div>
  )
}
