// The site settings page, and the hook every settings reader shares.
import { useEffect, useState } from "react"
import { RefreshCw, Settings } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { bytes } from "@/lib/format"

import { Field } from "./shared"

export type Settings = Record<string, string | boolean>

// Two pages write settings, and each loads only what it displays.
export function useSettings() {
  const [s, setS] = useState<Settings | null>(null)
  useEffect(() => { api<Settings>("/settings").then(setS).catch(() => {}) }, [])
  return {
    s,
    set: (k: string, v: string) => setS((old) => ({ ...(old ?? {}), [k]: v })),
    save: async (patch: Record<string, string>) => {
      try {
        await api("/settings", { method: "PUT", body: JSON.stringify(patch) })
        toast.success("已保存")
        // Only the saved keys and the `*_set` flags are taken from the hub: a
        // credential comes back as a flag, so the typed value must not linger,
        // while another card's unsaved edits on the same page must survive.
        const fresh = await api<Settings>("/settings")
        setS((old) => {
          const next = { ...old }
          for (const key of Object.keys(patch)) next[key] = fresh[key]
          for (const [key, value] of Object.entries(fresh)) if (key.endsWith("_set")) next[key] = value
          return next
        })
      } catch (e) {
        toast.error((e as Error).message)
      }
    },
  }
}

export const GEOIP_PROVIDERS: Record<string, string> = {
  ipinfo: "ipinfo.io（在线，无需数据库）",
  dbip: "db-ip LITE（本地库，无需注册）",
  maxmind: "MaxMind GeoLite2（本地库，需账号）",
}

export function SettingsTab() {
  const { s, set, save } = useSettings()
  const [updating, setUpdating] = useState(false)
  if (!s) return null
  const provider = String(s.geoip_provider ?? "ipinfo")

  async function updateGeoip() {
    setUpdating(true)
    try {
      const r = await api<{ provider: string; size: number }>("/geoip/update", { method: "POST" })
      toast.success(`${GEOIP_PROVIDERS[r.provider] ?? r.provider} 数据库已更新（${bytes(r.size)}）`)
      // The update time beside the button is part of what /settings reports.
      const fresh = await api<Settings>("/settings")
      set("geoip_updated", String(fresh.geoip_updated ?? ""))
      set("geoip_size", String(fresh.geoip_size ?? ""))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="gap-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="站点名称">
            <Input value={String(s.site_name ?? "")} onChange={(e) => set("site_name", e.target.value)} placeholder="Monitor" />
          </Field>
          <Field label="GitHub 代理" hint="留空直连。仅在 hub 自己拉不到 GitHub Release 时填。这个地址返回的字节会被安装到每一台服务器上，只填信得过的镜像">
            <Input
              value={String(s.github_proxy ?? "")}
              onChange={(e) => set("github_proxy", e.target.value)}
              placeholder="https://ghfast.top"
            />
          </Field>
        </div>
        <Field label="站点描述" hint="公开页标题下方展示，并写入页面 meta description">
          <Input
            value={String(s.site_description ?? "")}
            onChange={(e) => set("site_description", e.target.value)}
            placeholder="一句话介绍这个状态页"
          />
        </Field>
        {/* 不是 <label>：点文字不该切换开关，只有开关自己可点。
            aria-labelledby 保住读屏软件那边的关联。 */}
        <div className="flex items-center gap-2 text-sm">
          <Switch
            aria-labelledby="public-page-label"
            checked={s.public_page !== "off"}
            onCheckedChange={(v) => set("public_page", v ? "on" : "off")}
          />
          <span id="public-page-label">开放公开状态页，关闭后所有页面需登录</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch
            aria-labelledby="auto-ping-label"
            checked={s.auto_join_ping === "on"}
            onCheckedChange={(v) => set("auto_join_ping", v ? "on" : "off")}
          />
          <span id="auto-ping-label">新添加的服务器自动加入全部延迟检测任务</span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch
            aria-labelledby="cf-ip-label"
            checked={s.cf_connecting_ip === "on"}
            onCheckedChange={(v) => set("cf_connecting_ip", v ? "on" : "off")}
          />
          <span id="cf-ip-label">
            域名经 Cloudflare 橙云代理时，按 CF-Connecting-IP 识别服务器真实 IP
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Switch
            aria-labelledby="private-xff-label"
            checked={s.trust_private_xff !== "off"}
            onCheckedChange={(v) => set("trust_private_xff", v ? "on" : "off")}
          />
          <span id="private-xff-label">
            反代与 hub 之间经过内网时按 X-Forwarded-For 识别来源（Docker 等容器部署需要开；反代在本机或 hub 直接公网时可关闭以收紧）
          </span>
        </div>
        <Field
          label="信任的代理地址"
          hint="逗号分隔的 IP 或网段（如 172.18.0.4, 10.0.0.0/24）。列出的地址发来的 X-Forwarded-For 会被信任，比上面的内网开关更收紧；留空则只按上面两项判断"
        >
          <Input
            value={String(s.trusted_proxies ?? "")}
            onChange={(e) => set("trusted_proxies", e.target.value)}
            placeholder="172.18.0.4, 10.0.0.0/24"
          />
        </Field>
        <div>
          <Button
            size="sm"
            onClick={() =>
              save({
                site_name: String(s.site_name ?? ""),
                site_description: String(s.site_description ?? ""),
                github_proxy: String(s.github_proxy ?? ""),
                public_page: s.public_page === "off" ? "off" : "on",
                auto_join_ping: s.auto_join_ping === "on" ? "on" : "off",
                cf_connecting_ip: s.cf_connecting_ip === "on" ? "on" : "off",
                // Was missing from this call before: the switch above edited
                // local state only, and a reload quietly showed the unsaved
                // value as if it were the hub's.
                trust_private_xff: s.trust_private_xff === "off" ? "off" : "on",
                trusted_proxies: String(s.trusted_proxies ?? ""),
              })
            }
          >
            保存站点设置
          </Button>
        </div>
      </Card>

      <Card className="gap-4 p-5">
        <div>
          <h3 className="text-sm font-medium">地理位置识别</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            从服务器连接地址识别国家/地区，显示在状态页名称旁。本地库在 hub 上查询，不外发请求。
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="数据来源">
            <Select value={provider} onValueChange={(v) => set("geoip_provider", v)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(GEOIP_PROVIDERS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {provider === "maxmind" && (
            <Field label="账户 ID" hint="MaxMind 免费账号的 Account ID">
              <Input value={String(s.geoip_account_id ?? "")} onChange={(e) => set("geoip_account_id", e.target.value)} inputMode="numeric" />
            </Field>
          )}
        </div>
        {provider === "maxmind" && (
          <Field label="License Key" hint={s.geoip_license_key_set ? "已设置，留空不变" : "MaxMind 账号里 Manage License Keys 生成"}>
            <Input type="password" placeholder={s.geoip_license_key_set ? "••••••••" : ""} onChange={(e) => set("geoip_license_key", e.target.value)} />
          </Field>
        )}
        {provider !== "ipinfo" && (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" disabled={updating} onClick={updateGeoip}>
              <RefreshCw className={updating ? "animate-spin" : ""} /> {updating ? "更新中…" : "更新数据库"}
            </Button>
            {s.geoip_updated ? (
              <span className="text-xs text-muted-foreground">
                当前数据库 {bytes(Number(s.geoip_size))}，更新于 {new Date(Number(s.geoip_updated) * 1000).toLocaleString()}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">还没有本地数据库，点更新下载</span>
            )}
          </div>
        )}
        <div>
          <Button
            size="sm"
            onClick={() => {
              const patch: Record<string, string> = {
                geoip_provider: provider,
                ...(provider === "maxmind" ? { geoip_account_id: String(s.geoip_account_id ?? "") } : {}),
              }
              if (provider === "maxmind" && typeof s.geoip_license_key === "string" && s.geoip_license_key) {
                patch.geoip_license_key = s.geoip_license_key
              }
              save(patch)
            }}
          >
            保存识别设置
          </Button>
        </div>
      </Card>
    </div>
  )
}
