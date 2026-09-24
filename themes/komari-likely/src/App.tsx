import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { Moon, Sun, Wrench } from "lucide-react"

import { NodeCard } from "@/components/NodeCard"
import { Summary } from "@/components/Summary"
import { RegionPicker } from "@/components/RegionPicker"
import { IpCapsule } from "@/components/IpCapsule"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, useNodes, type Node } from "@/lib/api"
import { daysUntil } from "@/lib/format"

type Me = { authed: boolean; site_name: string; site_description: string; public_page: boolean }

// Split out because recharts is most of this bundle and the list page draws no
// chart. The landing page is 242 kB rather than 629 kB (77 kB gzipped against
// 188 kB), with the rest fetched immediately after it paints.
const loadDetail = () => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail }))
const NodeDetail = lazy(loadDetail)

// `/node/{id}` is a real page: it survives a reload, can be linked to, and back
// leaves the detail view rather than the site. The hub serves index.html for any
// unknown path, so no server-side route is required.
function useNodeRoute() {
  const read = () => {
    const match = location.pathname.match(/^\/node\/(\d+)/)
    return match ? Number(match[1]) : null
  }
  const [id, setId] = useState(read)
  useEffect(() => {
    const sync = () => setId(read())
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    id,
    (next: number | null) => {
      // The query rides along, so a filtered list that opens a node returns to
      // itself rather than to every machine again.
      history.pushState({}, "", next === null ? `/${location.search}` : `/node/${next}${location.search}`)
      setId(next)
      scrollTo(0, 0)
    },
  ] as const
}

function useTheme() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("theme")
    return saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches
  })
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
    localStorage.setItem("theme", dark ? "dark" : "light")
  }, [dark])
  return [dark, () => setDark((d) => !d)] as const
}

export default function App() {
  const [dark, toggleTheme] = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, error, closed } = useNodes()
  const [open, go] = useNodeRoute()

  const loadMe = useCallback(() => {
    // `|| "..."` because an empty message reads as no error: api() falls back to
    // res.statusText, which HTTP/2 and HTTP/3 removed, so a bodiless 502 from a
    // proxy arrives as "". The check below would then take the loading branch and
    // the retry button would never render.
    return api<Me>("/me")
      .then((next) => { setMe(next); setMeError("") })
      .catch((e: Error) => setMeError(e.message || "网络错误"))
  }, [])

  useEffect(() => {
    loadMe()
    // Warmed here rather than left to Suspense, which requests the chunk only
    // once a render reaches the detail view, itself waiting on /me. Without this
    // the split trades its first paint for a full-page skeleton over the first
    // node opened: 2.6s click-to-chart on 4G against 1.4s unsplit, 1.7s warm.
    void loadDetail()
  }, [loadMe])

  // The status page was closed while this tab was open. `me` holds whatever it
  // reported at load, so it is re-queried; the effect below then directs an
  // anonymous visitor to the panel rather than leaving them on a list that
  // stopped updating with only a red line to explain it.
  useEffect(() => {
    if (closed) void loadMe()
  }, [closed, loadMe])

  useEffect(() => {
    if (me && !me.public_page && !me.authed) location.href = "/admin/"
  }, [me])

  // What is alive above what is not -- komari's order -- then the order the
  // operator set in the panel.
  const sorted = [...(nodes ?? [])].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.sort - b.sort || a.id - b.id,
  )
  const selected = sorted.find((n) => n.id === open)
  // The group filter is a dimension the operator files servers under; the list
  // stays flat otherwise, as it always was.
  const [group, setGroup] = useState(() => new URLSearchParams(location.search).get("group") ?? "")
  // The filter is part of the address: a shared link opens on the same slice.
  // replaceState rather than push, so Back still leaves the site instead of
  // unwinding every filter tried on the way.
  const pick = (next: string) => {
    setGroup(next)
    const url = new URL(location.href)
    if (next) url.searchParams.set("group", next)
    else url.searchParams.delete("group")
    history.replaceState({}, "", url)
  }
  useEffect(() => {
    const sync = () => setGroup(new URLSearchParams(location.search).get("group") ?? "")
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])

  // The keyboard way out of a node page, matching how its card opens: Tab to
  // it, Enter in, Esc out.
  useEffect(() => {
    const back = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open !== null) go(null)
    }
    addEventListener("keydown", back)
    return () => removeEventListener("keydown", back)
  }, [open, go])
  const groups = [...new Set(sorted.map((n) => n.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  // A group nobody files by hand: whatever expires within the week belongs to
  // it, and leaves again on its own the day it stops being this week's problem.
  // Already-expired stays in -- un-renewed is the extreme case of expiring.
  const EXPIRING = "即将到期"
  const expiring = sorted.filter((n) => {
    const days = daysUntil(n.expires_at)
    return days !== null && days <= 7
  })
  // Red once any machine has slipped past: the worse fact wins the colour.
  const expired = expiring.some((n) => (daysUntil(n.expires_at) ?? 0) < 0)
  // Regions file themselves: every country code on the page becomes a filter of
  // its own, deduped against the operator's own groups so a name means one
  // thing however it arrived.
  const regions = [...new Set(sorted.map((n) => n.country).filter(Boolean))]
    .filter((r) => !groups.includes(r))
    .sort()
  const inGroup = (n: Node) =>
    group === EXPIRING
      ? expiring.some((e) => e.id === n.id)
      : groups.includes(group)
        ? n.group === group
        : n.country === group
  const shown = group ? sorted.filter(inGroup) : sorted
  const count = (name: string) => sorted.filter((n) => (name === EXPIRING ? expiring.some((e) => e.id === n.id) : groups.includes(name) ? n.group === name : n.country === name)).length
  const pill = (active: boolean) =>
    `inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? "border-primary bg-secondary font-medium" : "text-muted-foreground hover:bg-muted"}`

  // `/node/{id}` is a page people bookmark and share, so the tab needs the node's
  // name. The site name rather than a fixed string, since the hub lets an operator
  // rename the site.
  useEffect(() => {
    document.title = [selected?.name, me?.site_name || "Monitor"].filter(Boolean).join(" · ")
  }, [selected?.name, me?.site_name])

  // The description the operator wrote is both page copy and the meta a crawler
  // reads; the page keeps its own copy current with whatever /me reported.
  useEffect(() => {
    const text = me?.site_description?.trim() ?? ""
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]')
    if (text) {
      if (!meta) {
        meta = document.createElement("meta")
        meta.name = "description"
        document.head.appendChild(meta)
      }
      meta.content = text
    }
  }, [me?.site_description])

  // Only while there is nothing else to show. Once `me` has loaded, a later
  // failure belongs beside the page rather than over it.
  if (!me) return (
    <div className="grid min-h-svh place-items-center p-6 text-sm text-muted-foreground">
      {meError ? <div className="space-y-3 text-center"><p role="alert">加载失败：{meError}</p><Button onClick={loadMe}>重试</Button></div> : "加载中…"}
    </div>
  )

  // The status page is closed and nobody is signed in: redirect to the panel.
  if (!me.public_page && !me.authed) return null

  return (
    <div className="min-h-svh">
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4 py-3 sm:px-6">
          {/* The site name is the way back to the list, so a node page needs
              no back button of its own. */}
          <div className="flex items-center gap-3">
            <button className="font-semibold transition-opacity hover:opacity-70" onClick={() => go(null)}>
              {me.site_name || "Monitor"}
            </button>
            {me.site_description?.trim() && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{me.site_description.trim()}</span>
            )}
            <div className="flex-1" />
            {/* The panel is a separate app built into the hub, not part of this
                theme, so this is a navigation rather than a route. */}
            <Button variant="ghost" size="sm" asChild>
              <a href="/admin/">
                <Wrench /> {me.authed ? "进入后台" : "登录"}
              </a>
            </Button>
            <Button variant="ghost" size="icon" onClick={toggleTheme} title="切换主题">
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] space-y-5 px-4 py-4 sm:px-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {open !== null ? (
          !nodes ? (
            <Skeleton className="h-96" />
          ) : selected ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <NodeDetail node={selected} />
            </Suspense>
          ) : (
            <p className="py-16 text-center text-sm text-muted-foreground">
              服务器不存在或未公开。<button className="underline" onClick={() => go(null)}>返回列表</button>
            </p>
          )
        ) : !nodes ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-72" />
            ))}
          </div>
        ) : (
          <>
            <Summary nodes={shown} />
            {(groups.length > 0 || expiring.length > 0 || regions.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => pick("")} className={pill(group === "")}>
                  全部 {sorted.length}
                </button>
                {expiring.length > 0 && (
                  <button onClick={() => pick(group === EXPIRING ? "" : EXPIRING)} className={pill(group === EXPIRING)}>
                    {EXPIRING} <span className={expired ? "text-red-600" : "text-orange-500"}>{expiring.length}</span>
                  </button>
                )}
                {groups.map((g) => (
                  <button key={g} onClick={() => pick(g === group ? "" : g)} className={pill(g === group)}>
                    {g} {count(g)}
                  </button>
                ))}
                {/* Many countries would swallow the row, so they wait behind one
                    trigger: the globe, until a country is picked. */}
                {regions.length > 0 && (
                  <RegionPicker
                    regions={regions}
                    selected={regions.includes(group) ? group : ""}
                    onSelect={(r) => pick(r === group ? "" : r)}
                    countOf={count}
                    trigger={pill(regions.includes(group))}
                  />
                )}
              </div>
            )}
            {shown.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">还没有服务器</p>
            ) : (
              <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shown.map((n: Node) => (
                  <NodeCard key={n.id} node={n} onOpen={() => go(n.id)} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
      <IpCapsule />
    </div>
  )
}
