// Pieces every section of the panel reaches for: field layout, the
// confirm dialog, small utilities. Split out of the one-file Admin.tsx
// this panel used to be; a pure move, no behaviour change.
import { cloneElement, isValidElement, useId } from "react"
import { flushSync } from "react-dom"
import { Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { addresses, type Node } from "@/lib/api"


export const TRAFFIC_FIELDS = [
  ["total_rx", "累计下行"],
  ["total_tx", "累计上行"],
  ["month_rx", "本月下行"],
  ["month_tx", "本月上行"],
] as const
export const TRAFFIC_MODES: Record<string, string> = {
  sum: "上下行相加",
  max: "取较大值",
  up: "仅上行",
  down: "仅下行",
}

// Reordering uses the browser's view transitions, so displaced rows slide.
// Browsers without support jump instead.
export function animate(update: () => void) {
  if (document.startViewTransition) document.startViewTransition(() => flushSync(update))
  else update()
}

export function copy(text: string) {
  // The hub officially supports plain http://IP:端口 as its entry, and the
  // clipboard API only exists in secure contexts -- half the deployments this
  // panel serves would get a dead "点击复制" without the fallback below.
  if (window.isSecureContext && navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast.success("已复制"),
      () => toast.error("复制失败"),
    )
    return
  }
  // The pre-clipboard way: a textarea parked off-screen (display:none cannot be
  // selected, and an unselectable copy is an empty one), selected, then
  // execCommand. Deprecated but universally present, and the only route left.
  const area = document.createElement("textarea")
  area.value = text
  area.style.position = "fixed"
  area.style.left = "-9999px"
  document.body.appendChild(area)
  area.select()
  const ok = document.execCommand("copy")
  area.remove()
  if (ok) toast.success("已复制")
  else toast.error("复制失败")
}

// Every address a node has, each click-to-copy: pasting one into an ssh command
// is why they are shown.
export function Addresses({ node }: { node: Node }) {
  const list = addresses(node)
  if (!list.length) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <div className="flex flex-col items-start gap-y-0.5">
      {list.map((address) => (
        <button
          key={address}
          type="button"
          onClick={() => copy(address)}
          title="点击复制"
          className="tnum group inline-flex items-center gap-1 text-sm hover:text-foreground"
        >
          {address}
          <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      ))}
    </div>
  )
}

export function Field({ label, hint, className = "", children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  // Clicking the label should focus the control, which needs the label's
  // htmlFor to name the control's id. Callers hand-write the children, so the
  // id is generated here and injected into the first child with cloneElement
  // -- but only when that child IS the control: the shadcn Input (it spreads
  // props onto the native input) or a native input/select/textarea. A wrapping
  // div (an input with a button beside it) or a composite like Select takes no
  // id this way; injecting one would point the label at a container and
  // achieve nothing, so those stay exactly as they were.
  const id = useId()
  const [first, ...rest] = Array.isArray(children) ? children : [children]
  const isControl =
    isValidElement(first) &&
    (first.type === Input || (typeof first.type === "string" && ["input", "select", "textarea"].includes(first.type)))
  return (
    <div className={`space-y-2 ${className}`}>
      <Label htmlFor={isControl ? id : undefined} className="text-sm font-medium">{label}</Label>
      {isControl ? (
        <>
          {cloneElement(first as React.ReactElement<{ id?: string }>, { id })}
          {rest}
        </>
      ) : (
        children
      )}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}


export function ConfirmDialog({ title, description, confirmLabel, cancelLabel = "取消", busy = false, onClose, onConfirm }: {
  title: string
  description: string
  confirmLabel: string
  /** The cancel button's own text, for the one dialog whose cancel means something while busy (a restore in progress). */
  cancelLabel?: string
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-relaxed">{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-t pt-4">
          {/* Busy disables cancelling too: the confirmed action is under way and
              usually cannot be stopped (vacuum, a restore that has begun), and
              a cancel that only looks like it worked is worse than none. */}
          <Button variant="ghost" onClick={onClose} disabled={busy}>{cancelLabel}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
