import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import { Moon, Sun, Wrench } from "lucide-react"

import { NodeCard } from "@/components/NodeCard"
import { Summary } from "@/components/Summary"
import { RegionPicker } from "@/components/RegionPicker"
import { IpCapsule } from "@/components/IpCapsule"
import { BackgroundLayer, ThemeSettingsButton } from "@/components/ThemeSettings"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { api, useNodes, type Node } from "@/lib/api"
import { DisplayContext, parseThemeSettings } from "@/lib/display"
import { appliedFilter } from "@/lib/filter"
import { daysUntil } from "@/lib/format"
import { chosenDark, THEME_CHOICE } from "@/lib/theme"

type Me = {
  authed: boolean
  site_name: string
  site_description: string
  public_page: boolean
  /** Display settings the hub hands every visitor, raw strings. */
  theme?: Record<string, string>
}

// Split out because recharts is most of this bundle and the list page draws no
// chart. The landing page is 242 kB rather than 629 kB (77 kB gzipped against
// 188 kB), with the rest fetched immediately after it paints.
const loadDetail = () => import("@/components/NodeDetail").then((m) => ({ default: m.NodeDetail }))
const NodeDetail = lazy(loadDetail)

// `/node/{id}` is a real page: it survives a reload, can be linked to, and back
// leaves the detail view rather than the site. The hub serves index.html for any
// unknown path, so no server-side route is required.
function useNodeRoute() {
  // What the address names: a node, the list, or neither. `/` is the list and
  // so is `/index.html`, which the hub serves the page from as well;
  // `/node/5` is that node. Anything else is no page this theme has. It used
  // to get the list, which made a mistyped or stale link look like a working
  // one.
  const read = () => {
    const path = location.pathname.replace(/\/+$/, "")
    const match = path.match(/^\/node\/(\d+)$/)
    return { id: match ? Number(match[1]) : null, missing: !(match || path === "" || path === "/index.html") }
  }
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const sync = () => setRoute(read())
    addEventListener("popstate", sync)
    return () => removeEventListener("popstate", sync)
  }, [])
  return [
    route.id,
    (next: number | null) => {
      // The query rides along, so a filtered list that opens a node returns to
      // itself rather than to every machine again.
      history.pushState({}, "", next === null ? `/${location.search}` : `/node/${next}${location.search}`)
      setRoute({ id: next, missing: false })
      scrollTo(0, 0)
    },
    route.missing,
  ] as const
}

function useTheme() {
  // localStorage throws in private modes and embedded WebViews with storage
  // blocked -- an unreadable preference degrades to following the system
  // rather than a SecurityError that takes the whole page down with it.
  const readChoice = () => {
    try {
      return chosenDark(localStorage.getItem(THEME_CHOICE))
    } catch {
      return null
    }
  }
  // "System mode" is the absence of an explicit choice: nothing stored. The
  // page tracks the scheme live while in it (below), and it ends at the first
  // manual toggle -- the only thing that ever writes a choice, see
  // `THEME_CHOICE`.
  const [followSystem, setFollowSystem] = useState(() => readChoice() === null)
  const [dark, setDark] = useState(() => readChoice() ?? matchMedia("(prefers-color-scheme: dark)").matches)
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])
  // In system mode the page tracks the scheme live: it can flip while the tab
  // is open (sunset schedules, a keyboard dark-mode key), and a value read
  // once at mount would strand the page in yesterday's mode.
  useEffect(() => {
    if (!followSystem) return
    const mq = matchMedia("(prefers-color-scheme: dark)")
    const sync = () => setDark(mq.matches)
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [followSystem])
  // The browser chrome -- address bar, status bar -- takes its colour from
  // this meta. The two media-qualified metas in index.html answer for the
  // moment before JS runs; from here on the effective colour is whatever this
  // page resolved to, manual toggles and system flips alike, written as the
  // single value the current mode actually shows.
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0a0a0a" : "#ffffff")
  }, [dark])
  return [dark, () => {
    const next = !dark
    // The toggle is the choice, and the only place one is stored. A page
    // that saved the scheme it happened to open in pinned every visitor to
    // their first visit's scheme, and following the system lasted exactly
    // that one visit.
    try {
      localStorage.setItem(THEME_CHOICE, next ? "dark" : "light")
    } catch {
      // The choice lives for this session only; that is the graceful outcome,
      // not an error worth surfacing.
    }
    setFollowSystem(false)
    setDark(next)
  }] as const
}

export default function App() {
  const [dark, toggleTheme] = useTheme()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState("")
  const { nodes, error, closed } = useNodes()
  const [open, go, missing] = useNodeRoute()

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

  // The operator's display settings, saved key by key: what the hub refuses
  // shows in the panel rather than half-applying here.
  //
  // Saves are serialized through one ref-held chain. HTTP/2 does not promise
  // that responses arrive in the order their requests were sent (multiplexed
  // streams, a proxy free to reorder), so two in-flight PUTs race for last
  // write -- 「恢复默认」firing nineteen keys while a URL field's blur commits
  // is the shape that lost, leaving the hub holding whichever landed later
  // rather than whichever the operator did. Appending each save to the tail of
  // the previous one eliminates the race entirely: the chain runs them in
  // order, and merges each patch into me.theme only as its own save succeeds,
  // still in order. The chain itself swallows failures so a rejected save
  // cannot wedge every later one behind it; the caller's promise keeps the
  // rejection so the panel can still show it.
  const saveQueue = useRef(Promise.resolve())
  const saveSettings = useCallback(
    (patch: Record<string, string>) => {
      const doSave = () =>
        api("/settings", { method: "PUT", body: JSON.stringify(patch) }).then(() => {
          setMe((old) => (old ? { ...old, theme: { ...(old.theme ?? {}), ...patch } } : old))
        })
      const p = saveQueue.current.then(doSave)
      saveQueue.current = p.catch(() => {})
      return p
    },
    [],
  )

  // What is alive above what is not -- komari's order -- then the order the
  // operator set in the panel.
  const sorted = [...(nodes ?? [])].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.sort - b.sort || a.id - b.id,
  )
  const selected = sorted.find((n) => n.id === open)
  // The group filter is a dimension the operator files servers under; the list
  // stays flat otherwise, as it always was.
  //
  // The filter is part of the address: a shared link opens on the same slice.
  // What the address asks for is kept as asked; whether it names a slice --
  // any -- is decided once the pills are known, below.
  const [requested, setRequested] = useState(() => new URLSearchParams(location.search).get("group") ?? "")
  // replaceState rather than push, so Back still leaves the site instead of
  // unwinding every filter tried on the way.
  const pick = (next: string) => {
    setRequested(next)
    const url = new URL(location.href)
    if (next) url.searchParams.set("group", next)
    else url.searchParams.delete("group")
    history.replaceState({}, "", url)
  }
  useEffect(() => {
    const sync = () => setRequested(new URLSearchParams(location.search).get("group") ?? "")
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
  const count = (name: string) => sorted.filter((n) => (name === EXPIRING ? expiring.some((e) => e.id === n.id) : groups.includes(name) ? n.group === name : n.country === name)).length
  // The pills stay thumb-sized on a phone (44px is the smallest a finger hits
  // without missing) and drop back to their compact height from sm up, so the
  // desktop row looks exactly as it did. The RegionPicker trigger wears the
  // same classes, so it grows with them.
  const pill = (active: boolean) =>
    `frost-chip inline-flex min-h-11 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors sm:min-h-0 ${active ? "border-primary bg-secondary font-medium" : "text-muted-foreground hover:bg-muted"}`

  // `/node/{id}` is a page people bookmark and share, so the tab needs the node's
  // name. The site name rather than a fixed string, since the hub lets an operator
  // rename the site.
  useEffect(() => {
    document.title = [selected?.name, me?.site_name || "Monitor"].filter(Boolean).join(" · ")
  }, [selected?.name, me?.site_name])

  // One class on the root frosts every surface while a background picture is
  // painted, and changes nothing while one is not; the picture itself is
  // BackgroundLayer's business. The accompanying variable is how solid the
  // frost is, as the operator set it -- a number the CSS in index.css turns
  // into the card and popover alphas. This must run even on the error and
  // loading shapes below.
  useEffect(() => {
    const t = me?.theme
    document.documentElement.classList.toggle("bg-on", !!t && t.bg_enabled === "on" && !!(t.bg_desktop || t.bg_mobile))
    const bg = parseThemeSettings(t).bg
    document.documentElement.style.setProperty("--card-opacity", `${bg.cardOpacity}%`)
    document.documentElement.style.setProperty("--card-blur", `${bg.cardBlur}px`)
    document.documentElement.style.setProperty("--content-w", `${parseThemeSettings(t).layout.contentWidth}px`)
  }, [me?.theme])

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

  // What this page shows, as the operator set it from the hub.
  const ts = parseThemeSettings(me.theme)

  // The pills on offer, each of which is a filter: a group, a region while
  // region grouping is on, the expiring one while it is on and something
  // expires. The filter applied is what the address asked for if it is one of
  // them, and none otherwise -- see `appliedFilter`.
  const offered = (name: string) =>
    name === EXPIRING
      ? ts.display.expiring && expiring.length > 0
      : groups.includes(name) || (ts.display.region && regions.includes(name))
  const group = appliedFilter(requested, offered)
  const inGroup = (n: Node) =>
    group === EXPIRING
      ? expiring.some((e) => e.id === n.id)
      : groups.includes(group)
        ? n.group === group
        : n.country === group
  const shown = group ? sorted.filter(inGroup) : sorted

  return (
    <DisplayContext value={ts.display}>
    <div className="min-h-svh">
      <BackgroundLayer bg={ts.bg} dark={dark} />
      <header className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-[var(--content-w,1400px)] px-4 py-3 sm:px-6">
          {/* One way back to the list among the detail page's own; an
              operator's logo sits beside the site name. */}
          <div className="flex items-center gap-3">
            {ts.layout.logo && (
              // max-w-32: an over-wide logo is clamped, or it pushes the site
              // name and the header's buttons off the right edge of a phone.
              <img src={ts.layout.logo} alt="" className="h-6 max-w-32 w-auto shrink-0 rounded-sm" loading="lazy" />
            )}
            <button className="font-semibold transition-opacity hover:opacity-70" onClick={() => go(null)}>
              {me.site_name || "Monitor"}
            </button>
            {me.site_description?.trim() && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{me.site_description.trim()}</span>
            )}
            <div className="flex-1" />
            {/* The panel is a separate app built into the hub, not part of this
                theme, so this is a navigation rather than a route. The wording
                lives in the hover text alone, the shape of an icon reading the
                same signed in or out. */}
            {/* max-sm:size-11 -- the header icons stay thumb-sized (44px) on a
                phone and revert to 36px from sm up, keeping the desktop bar as
                compact as it always was. */}
            <Button variant="ghost" size="icon" asChild className="max-sm:size-11">
              <a href="/admin/" title={me.authed ? "进入后台" : "登录"} aria-label={me.authed ? "进入后台" : "登录"}>
                <Wrench />
              </a>
            </Button>
            {me.authed && <ThemeSettingsButton settings={ts} onSave={saveSettings} />}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              title="切换主题"
              aria-label="切换深浅色"
              className="max-sm:size-11"
            >
              {dark ? <Sun /> : <Moon />}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[var(--content-w,1400px)] space-y-5 px-4 py-4 sm:px-6">
        {error && <p className="text-sm text-destructive">{error}</p>}

        {missing ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            没有这个页面：{location.pathname}。<button className="underline" onClick={() => go(null)}>返回状态页</button>
          </p>
        ) : open !== null ? (
          !nodes ? (
            <Skeleton className="h-96" />
          ) : selected ? (
            <Suspense fallback={<Skeleton className="h-96" />}>
              <NodeDetail node={selected} onBack={() => go(null)} />
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
            <Summary nodes={shown} showCost={me.authed || ts.display.costPublic} showBusiest={ts.display.busiest} />
            {(groups.length > 0 || (ts.display.expiring && expiring.length > 0) || (ts.display.region && regions.length > 0)) && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button onClick={() => pick("")} className={pill(group === "")}>
                  全部 {sorted.length}
                </button>
                {ts.display.expiring && expiring.length > 0 && (
                  <button onClick={() => pick(group === EXPIRING ? "" : EXPIRING)} className={pill(group === EXPIRING)}>
                    {EXPIRING} <span className={expired ? "text-red-700" : "text-orange-700"}>{expiring.length}</span>
                  </button>
                )}
                {groups.map((g) => (
                  <button key={g} onClick={() => pick(g === group ? "" : g)} className={pill(g === group)}>
                    {g} {count(g)}
                  </button>
                ))}
                {/* Many countries would swallow the row, so they wait behind one
                    trigger: the globe, until a country is picked. */}
                {ts.display.region && regions.length > 0 && (
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
              <div className="py-16 text-center text-sm text-muted-foreground">
              <p>还没有服务器</p>
              <p className="mt-1 text-xs">（站点管理员可从右上角「登录」进入后台，添加第一台服务器）</p>
            </div>
            ) : (
              <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shown.map((n: Node) => (
                  <NodeCard key={n.id} node={n} onOpen={() => go(n.id)} show={ts.display} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
      {ts.display.ipCapsule && <IpCapsule />}
    </div>
    </DisplayContext>
  )
}
