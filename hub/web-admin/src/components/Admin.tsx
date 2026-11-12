// The panel's shell: the section nav and the section it points at. Each
// section lives in ./admin/<section>.tsx, split out of the one file this used
// to be -- a pure move, with the sections unchanged.

import { Bell, Database, Palette, Radio, Server, Settings, Shield } from "lucide-react"

import { type Node } from "@/lib/api"


import { Nodes } from "./admin/nodes"
import { Ping } from "./admin/ping"
import { Themes } from "./admin/themes"
import { SettingsTab } from "./admin/settings"
import { Notify } from "./admin/notify"
import { Security } from "./admin/security"
import { Data } from "./admin/data"
const ADMIN_SECTIONS = [
  { path: "/admin/nodes", label: "服务器", icon: Server },
  { path: "/admin/ping", label: "延迟", icon: Radio },
  { path: "/admin/notify", label: "通知", icon: Bell },
  { path: "/admin/data", label: "数据", icon: Database },
  { path: "/admin/themes", label: "主题", icon: Palette },
  { path: "/admin/security", label: "安全", icon: Shield },
  { path: "/admin/settings", label: "设置", icon: Settings },
] as const

export function Admin({
  path,
  go,
  nodes,
  refresh,
  site,
  siteName,
  canProvision,
}: {
  path: string
  go: (to: string) => void
  nodes: Node[]
  refresh: () => void
  site: string
  siteName: string
  canProvision: boolean
}) {
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <nav className="flex gap-1 overflow-x-auto md:w-44 md:shrink-0 md:flex-col md:overflow-visible">
        {ADMIN_SECTIONS.map(({ path: to, label, icon: Icon }) => {
          const active = path === to
          return (
            <button
              key={to}
              onClick={() => go(to)}
              aria-current={active ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                active ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          )
        })}
      </nav>

      <div className="min-w-0 flex-1">
        {path === "/admin/ping" ? (
          <Ping nodes={nodes} />
        ) : path === "/admin/notify" ? (
          <Notify nodes={nodes} refresh={refresh} />
        ) : path === "/admin/data" ? (
          <Data />
        ) : path === "/admin/themes" ? (
          <Themes />
        ) : path === "/admin/security" ? (
          <Security siteName={siteName} />
        ) : path === "/admin/settings" ? (
          <SettingsTab />
        ) : (
          <Nodes nodes={nodes} refresh={refresh} site={site} canProvision={canProvision} go={go} />
        )}
      </div>
    </div>
  )
}
