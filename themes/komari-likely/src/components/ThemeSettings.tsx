import { useEffect, useState } from "react"
import { RotateCcw, Settings2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { apartFromExternalRequests, knowsExternalRequests, type Bg, type ThemeSettings } from "@/lib/display"
import { followCommitted } from "@/lib/draft"
import { cn } from "@/lib/utils"

/**
 * The picture behind the page: full-viewport, fixed, behind everything and
 * never in the way. Each size class gets its own source; an unset one falls
 * back to the other. A source may itself carry two pictures, `light|dark`,
 * so the modes can each get one that suits them -- a single segment serves
 * both. A blur is oversize-scaled so its softened edges do not show as a
 * frame.
 */
function pickVariant(link: string, dark: boolean) {
  const [light, darkPart] = link.split("|")
  return (dark ? darkPart || light : light).trim()
}

/** Every setting the panel writes, at its default: what 「恢复默认」 puts back. */
const DEFAULTS: Record<string, string> = {
  bg_enabled: "off", bg_desktop: "", bg_mobile: "", bg_opacity: "100", bg_blur: "0", bg_fit: "cover",
  bg_position: "center", card_opacity: "70", card_blur: "64",
  content_width: "1400", logo_url: "",
  cost_public: "off", show_busiest: "on", show_swap: "on", show_speed: "on", show_billing: "on",
  ip_capsule: "off", expiring_group: "on", region_group: "on", flags_cdn: "on", fx_api: "on",
}

/** 「恢复默认」 as the two requests it goes in: the keys every hub reads, then
 *  the two from v1.6.14 on. A hub that has never heard of those refuses the
 *  request they are in -- all of it, changing nothing -- so they travel apart. */
const { earlier: EARLIER_DEFAULTS, later: LATER_DEFAULTS } = apartFromExternalRequests(DEFAULTS)

/** Whether the viewport currently matches `query`. The change listener lets a
 *  crossing re-render; the cleanup takes the listener back down. Exists so the
 *  background can pick one source in JS instead of shipping both and hiding
 *  one in CSS -- hidden is not undownloaded, see BackgroundLayer. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const sync = () => setMatches(mq.matches)
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [query])
  return matches
}

export function BackgroundLayer({ bg, dark }: { bg: Bg; dark: boolean }) {
  const wide = useMediaQuery("(min-width: 768px)")
  if (!bg.enabled) return null
  // Only the source the viewport can show is rendered at all. This used to be
  // two <img>s with the md: classes hiding one of them -- but a hidden img is
  // still downloaded, so a phone paid for the desktop picture (and vice versa
  // on a metered desktop link). One img, its src picked at the breakpoint; a
  // resize crosses it and the hook re-renders with the other source.
  const src = (wide ? pickVariant(bg.desktop, dark) || pickVariant(bg.mobile, dark)
    : pickVariant(bg.mobile, dark) || pickVariant(bg.desktop, dark))
  if (!src) return null
  const painted = {
    src,
    alt: "",
    style: {
      opacity: bg.opacity,
      filter: bg.blur ? `blur(${bg.blur}px)` : undefined,
      transform: bg.blur ? "scale(1.08)" : undefined,
      objectFit: bg.fit,
      objectPosition: bg.position,
    },
  }
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      <img className="absolute inset-0 block h-full w-full object-cover" {...painted} />
    </div>
  )
}

/** A URL that commits on blur or Enter, not per keystroke: a half-pasted link
 *  would otherwise flash a broken image with every letter. */
function UrlField({ label, value, onCommit }: { label: string; value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value)
  // `value` is controlled by the caller and moves under the field -- 「恢复默认」
  // emptying every link, a save from the hub's theme tab -- and the draft must
  // follow when it moves, or the box keeps showing the old value while the next
  // blur quietly PUTs it back. Reconciled here in render rather than an effect
  // or a caller-side key: an effect paints one stale frame first, and a key
  // would remount the input, dropping focus and undo history on every
  // server-side change.
  //
  // The condition is `saved !== value`, not `draft has drifted`: when the typed
  // draft happens to equal what the server just confirmed, `saved` must still
  // move -- otherwise it holds a value from before the edit, the next change
  // back to that old value reads as "no movement", and the draft survives it.
  // Exactly the shape of typing a link, committing it, then hitting 恢复默认.
  const [saved, setSaved] = useState(value)
  const shown = followCommitted(draft, saved, value)
  if (saved !== value) {
    setSaved(value)
    setDraft(shown)
  }
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          // No change, no PUT: focus often enters and leaves without editing
          // (Enter routes through here too), and a no-op save is one more
          // request racing whatever real save is in flight. Committing only
          // what differs from the server's value keeps the queue quiet.
          const next = shown.trim()
          if (next !== value) onCommit(next)
        }}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        placeholder="https://…"
        spellCheck={false}
        className="mt-1 w-full rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:border-ring"
      />
    </label>
  )
}

function Slider({ label, value, min, max, render, onPick }: {
  label: string; value: number; min: number; max: number; render: (v: number) => string; onPick: (v: number) => void
}) {
  // The drag previews locally and commits once, on release: firing per step
  // sent one PUT per value on the way past, and whichever of those landed
  // last won -- not necessarily the one the handle ended on. The draft is
  // dropped the moment it is committed: a refused save then snaps the thumb
  // back to the saved value with the red line this panel already shows, and
  // no half-forgotten draft can resurface on a later blur to overwrite
  // settings saved in the meantime.
  const [draft, setDraft] = useState<number | null>(null)
  const shown = draft ?? value
  const commit = () => {
    if (draft !== null && draft !== value) {
      onPick(draft)
    }
    setDraft(null)
  }
  return (
    <label className="block">
      <span className="flex justify-between text-xs text-muted-foreground">
        {label}
        <span className="tnum">{render(shown)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={shown}
        onChange={(e) => setDraft(e.target.valueAsNumber)}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="mt-1 w-full accent-foreground"
      />
    </label>
  )
}

function Toggle({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="text-xs">{label}</p>
        {hint && <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-foreground" : "bg-muted-foreground/30",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-background transition-all",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1 border-t pt-2 first:border-t-0 first:pt-0">
      <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {children}
    </section>
  )
}

/** The signed-in operator's handle on what the status page shows: the
 *  background and the display toggles, all of it saved to the hub so every
 *  visitor sees the same picture. Every control applies as it is moved; what
 *  the hub refuses shows as a line of red rather than a silent nothing. */
export function ThemeSettingsButton({ settings, raw, onSave }: {
  settings: ThemeSettings
  /** The settings as the hub sent them, which is where what it knows is read. */
  raw?: Record<string, string>
  onSave: (patch: Record<string, string>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  // Between the press on 「恢复默认」 and the one that means it.
  const [confirming, setConfirming] = useState(false)
  const dismiss = () => { setOpen(false); setConfirming(false) }
  const save = (patch: Record<string, string>) =>
    onSave(patch).then(() => setError(""), (e: Error) => setError(e.message || "保存失败"))
  // On a hub from v1.6.14 on. On an earlier one the two switches are not
  // offered, since what they write would be refused, and the reset leaves
  // their keys out rather than be refused with them.
  const external = knowsExternalRequests(raw)
  const restore = () => {
    const done = external ? onSave(EARLIER_DEFAULTS).then(() => onSave(LATER_DEFAULTS)) : onSave(EARLIER_DEFAULTS)
    setConfirming(false)
    done.then(() => setError(""), (e: Error) => setError(e.message || "保存失败"))
  }

  // Esc closes the panel no matter where focus sits: the panel is often opened
  // by touch, which leaves focus on <body>, outside this wrapper and out of
  // reach of an onKeyDown. The listener takes capture and stops the event so
  // App's own Esc -- back out of a node page -- does not also fire on the same
  // press; the panel dismisses first, the next press navigates.
  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      dismiss()
    }
    addEventListener("keydown", close, true)
    return () => removeEventListener("keydown", close, true)
  }, [open])

  const { bg, display, layout } = settings
  return (
    <div className="relative">
      {/* max-sm:size-11 -- a thumb needs 44px; the desktop icon stays 36px. */}
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen((o) => !o)}
        title="主题设置"
        aria-label="主题设置"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="max-sm:size-11"
      >
        <Settings2 />
      </Button>
      {open && (
        <>
          {/* Click anywhere else closes; the panel sits above this blanket. */}
          <div className="fixed inset-0 z-20" onClick={dismiss} aria-hidden />
          {/* Narrow screens first: anchored to the trigger's right edge, the
              w-80 panel overflows a 390px viewport by 17px, and the body does
              not scroll sideways to reveal what was cut. Below sm it becomes a
              centered banner fixed near the top instead, inset-x-4 leaving
              breathing room either side; from sm up it returns to the anchored
              popover the desktop has always had. */}
          <div
            role="dialog"
            aria-label="主题设置"
            className="fixed inset-x-4 top-20 z-30 max-h-[80svh] space-y-3 overflow-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg backdrop-blur-[64px] sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80"
          >
            <div>
              <p className="text-xs font-medium">主题设置</p>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                保存到服务器，对全部访客生效。
              </p>
            </div>

            <Section title="背景图">
              <Toggle
                label="启用背景图"
                checked={bg.enabled}
                onChange={(on) => save({ bg_enabled: on ? "on" : "off" })}
              />
              <div className="pt-1">
                <UrlField label="桌面版" value={bg.desktop} onCommit={(desktop) => save({ bg_desktop: desktop })} />
                <UrlField label="移动版" value={bg.mobile} onCommit={(mobile) => save({ bg_mobile: mobile })} />
                {/* The links above open prefilled with whatever the panel's
                    theme tab saved, because both entrances read and write the
                    same hub keys -- fill them here and they appear there. A
                    link may carry two pictures, light|dark, one per mode. */}
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  与后台「主题」栏共用同一份配置；链接可用「亮|暗」两段区分明暗模式背景。
                </p>
                <div className="mt-2 space-y-2">
                  <Slider
                    label="透明度"
                    value={Math.round(bg.opacity * 100)}
                    min={0}
                    max={100}
                    render={(v) => `${v}%`}
                    onPick={(v) => save({ bg_opacity: String(v) })}
                  />
                  <Slider
                    label="模糊"
                    value={bg.blur}
                    min={0}
                    max={20}
                    render={(v) => `${v}px`}
                    onPick={(blur) => save({ bg_blur: String(blur) })}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">铺满方式</span>
                    <div className="flex gap-1">
                      {(["cover", "contain"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => save({ bg_fit: mode })}
                          className={cn(
                            "rounded-md border px-2 py-1 text-xs transition-colors",
                            bg.fit === mode
                              ? "border-primary bg-secondary font-medium"
                              : "text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {mode === "cover" ? "裁切铺满" : "完整显示"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* Where the fit crops from -- a portrait's head is at the
                      top, and `cover` alone would take it from the middle. */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">对齐方式</span>
                    <div className="flex gap-1">
                      {(["center", "top", "bottom", "left", "right"] as const).map((p) => (
                        <button
                          key={p}
                          title={p}
                          onClick={() => save({ bg_position: p })}
                          className={cn(
                            "size-6 rounded-md border text-xs transition-colors",
                            bg.position === p
                              ? "border-primary bg-secondary font-medium"
                              : "text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {p === "center" ? "中" : p === "top" ? "上" : p === "bottom" ? "下" : p === "left" ? "左" : "右"}
                        </button>
                      ))}
                    </div>
                  </div>
                  {/* The frost half of the picture treatment: how solid the
                      cards are, and how smeared what shows through them is.
                      Taken to the bottom together the picture reads plainly
                      through the cards. The image's own opacity and blur
                      above are different knobs and they compose. */}
                  <Slider
                    label="卡片浓度"
                    value={Math.round(bg.cardOpacity)}
                    min={0}
                    max={100}
                    render={(v) => `${v}%`}
                    onPick={(v) => save({ card_opacity: String(v) })}
                  />
                  <Slider
                    label="卡片模糊"
                    value={Math.round(bg.cardBlur)}
                    min={0}
                    max={64}
                    render={(v) => `${v}px`}
                    onPick={(v) => save({ card_blur: String(v) })}
                  />
                </div>
              </div>
            </Section>

            <Section title="布局">
              {/* How much of a wide screen the cards may spread across; small
                  screens never reach the cap, so it changes nothing there. */}
              <Slider
                label="内容宽度"
                value={Math.round(layout.contentWidth)}
                min={1000}
                max={2560}
                render={(v) => `${v}px`}
                onPick={(v) => save({ content_width: String(v) })}
              />
              <div className="pt-1">
                <UrlField label="标题栏 Logo" value={layout.logo} onCommit={(logo) => save({ logo_url: logo })} />
              </div>
            </Section>

            <Section title="显示">
              <Toggle
                label="每日成本对访客可见"
                hint="关闭后仅登录可见"
                checked={display.costPublic}
                onChange={(on) => save({ cost_public: on ? "on" : "off" })}
              />
              <Toggle label="汇总区最忙服务器" checked={display.busiest} onChange={(on) => save({ show_busiest: on ? "on" : "off" })} />
              <Toggle label="卡片 SWAP" checked={display.swap} onChange={(on) => save({ show_swap: on ? "on" : "off" })} />
              <Toggle label="卡片网速" checked={display.speed} onChange={(on) => save({ show_speed: on ? "on" : "off" })} />
              <Toggle
                label="卡片到期与价格"
                checked={display.billing}
                onChange={(on) => save({ show_billing: on ? "on" : "off" })}
              />
            </Section>

            <Section title="功能">
              <Toggle
                label="访客 IP 提示"
                checked={display.ipCapsule}
                onChange={(on) => save({ ip_capsule: on ? "on" : "off" })}
              />
              <Toggle
                label="即将到期分组"
                checked={display.expiring}
                onChange={(on) => save({ expiring_group: on ? "on" : "off" })}
              />
              <Toggle
                label="区域分组"
                checked={display.region}
                onChange={(on) => save({ region_group: on ? "on" : "off" })}
              />
            </Section>

            {/* The two places the page itself asks someone other than the hub.
                Both are on by default, as they always were; a site that would
                rather not have its visitors talked to can switch them off. */}
            {external && (
              <Section title="外部请求">
                <Toggle
                  label="国旗图片"
                  hint="从 jsDelivr 加载 Twemoji 国旗。关闭后显示系统自带的表情国旗，不再为此向第三方发请求。"
                  checked={display.flags}
                  onChange={(on) => save({ flags_cdn: on ? "on" : "off" })}
                />
                <Toggle
                  label="汇率换算"
                  hint="从 jsDelivr 和 open.er-api.com 取当天的汇率来换算价格。关闭后价格按各自的原币显示。"
                  checked={display.fx}
                  onChange={(on) => save({ fx_api: on ? "on" : "off" })}
                />
              </Section>
            )}

            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
            {confirming ? (
              /* One press used to put every setting back at once, background
                 links included, with nothing to undo it by. */
              <span role="alert" className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="text-muted-foreground">
                  把全部 {Object.keys(external ? DEFAULTS : EARLIER_DEFAULTS).length} 项设置恢复默认？背景图链接也会清空。
                </span>
                <button onClick={restore} className="font-medium text-red-700 underline underline-offset-2">
                  确认恢复
                </button>
                <button onClick={() => setConfirming(false)} className="text-muted-foreground underline underline-offset-2">
                  取消
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <RotateCcw className="size-3" />
                恢复默认
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
