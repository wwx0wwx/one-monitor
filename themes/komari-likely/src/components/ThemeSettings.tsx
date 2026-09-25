import { useState } from "react"
import { RotateCcw, Settings2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Bg, ThemeSettings } from "@/lib/display"
import { cn } from "@/lib/utils"

/**
 * The picture behind the page: full-viewport, fixed, behind everything and
 * never in the way. Each size class gets its own source; an unset one falls
 * back to the other. A blur is oversize-scaled so its softened edges do not
 * show as a frame.
 */
export function BackgroundLayer({ bg }: { bg: Bg }) {
  if (!bg.enabled) return null
  const desktop = bg.desktop || bg.mobile
  const mobile = bg.mobile || bg.desktop
  if (!desktop) return null
  const painted = (src: string) => ({
    src,
    alt: "",
    style: {
      opacity: bg.opacity,
      filter: bg.blur ? `blur(${bg.blur}px)` : undefined,
      transform: bg.blur ? "scale(1.08)" : undefined,
      objectFit: bg.fit,
    },
  })
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      <img className="absolute inset-0 hidden h-full w-full object-cover md:block" {...painted(desktop)} />
      <img className="absolute inset-0 block h-full w-full object-cover md:hidden" {...painted(mobile)} />
    </div>
  )
}

/** A URL that commits on blur or Enter, not per keystroke: a half-pasted link
 *  would otherwise flash a broken image with every letter. */
function UrlField({ label, value, onCommit }: { label: string; value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value)
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft.trim())}
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
  return (
    <label className="block">
      <span className="flex justify-between text-xs text-muted-foreground">
        {label}
        <span className="tnum">{render(value)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onPick(e.target.valueAsNumber)}
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
export function ThemeSettingsButton({ settings, onSave }: {
  settings: ThemeSettings
  onSave: (patch: Record<string, string>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState("")
  const save = (patch: Record<string, string>) =>
    onSave(patch).then(() => setError(""), (e: Error) => setError(e.message || "保存失败"))

  const { bg, display } = settings
  return (
    <div
      className="relative"
      onKeyDown={(e) => e.key === "Escape" && open && (e.stopPropagation(), setOpen(false))}
    >
      <Button variant="ghost" size="icon" onClick={() => setOpen((o) => !o)} title="主题设置">
        <Settings2 />
      </Button>
      {open && (
        <>
          {/* Click anywhere else closes; the panel sits above this blanket. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute right-0 top-full z-30 mt-2 max-h-[80svh] w-80 space-y-3 overflow-auto rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg">
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
                </div>
              </div>
            </Section>

            <Section title="显示">
              <Toggle
                label="每日成本对访客可见"
                hint="关闭后仅登录可见"
                checked={display.costPublic}
                onChange={(on) => save({ cost_public: on ? "on" : "off" })}
              />
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

            {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
            <button
              onClick={() =>
                save({
                  bg_enabled: "off", bg_desktop: "", bg_mobile: "", bg_opacity: "100", bg_blur: "0", bg_fit: "cover",
                  cost_public: "off", show_swap: "on", show_speed: "on", show_billing: "on",
                  ip_capsule: "on", expiring_group: "on", region_group: "on",
                })
              }
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCcw className="size-3" />
              恢复默认
            </button>
          </div>
        </>
      )}
    </div>
  )
}
