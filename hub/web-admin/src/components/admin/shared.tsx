// Pieces every section of the panel reaches for: field layout, the
// confirm dialog, small utilities. Split out of the one-file Admin.tsx
// this panel used to be; a pure move, no behaviour change.
import { flushSync } from "react-dom"
import { Copy } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
  navigator.clipboard.writeText(text).then(
    () => toast.success("已复制"),
    () => toast.error("复制失败"),
  )
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
  return (
    <div className={`space-y-2 ${className}`}>
      <Label className="text-sm font-medium">{label}</Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}


export function ConfirmDialog({ title, description, confirmLabel, busy = false, onClose, onConfirm }: {
  title: string
  description: string
  confirmLabel: string
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
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
