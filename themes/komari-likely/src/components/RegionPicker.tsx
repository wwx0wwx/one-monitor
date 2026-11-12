import { useEffect, useState } from "react"
import { Check, ChevronsUpDown } from "lucide-react"

import { Flag } from "@/components/Flag"

/** The countries on the page folded into one control: a fleet of many flags
 *  would swallow the filter row, so they wait behind a single trigger -- the
 *  globe until one is picked, that country's flag once it has been. */
export function RegionPicker({ regions, selected, onSelect, countOf, trigger }: {
  regions: string[]
  selected: string
  onSelect: (region: string) => void
  countOf: (region: string) => number
  trigger: string
}) {
  const [open, setOpen] = useState(false)
  // Esc closes the list no matter where focus sits -- a touch open leaves
  // focus on <body>, outside this wrapper and out of reach of an onKeyDown.
  // Capture, so App's own Esc (back out of a node page) never fires on the
  // same press that dismissed the list.
  useEffect(() => {
    if (!open) return
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      setOpen(false)
    }
    addEventListener("keydown", close, true)
    return () => removeEventListener("keydown", close, true)
  }, [open])
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className={trigger} aria-expanded={open}>
        <Flag country={selected} className="size-3.5" />
        {selected || "区域"}
        <ChevronsUpDown className="size-3 opacity-60" />
      </button>
      {open && (
        <>
          {/* Click anywhere else closes; the panel sits above this blanket. */}
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} aria-hidden />
          {/* role=listbox + option, so what aria-expanded announces is backed
              by options a screen reader can enumerate and hear chosen. */}
          <div
            role="listbox"
            aria-label="区域"
            className="absolute top-full left-0 z-30 mt-1 max-h-64 w-44 overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg backdrop-blur-xl"
          >
            {regions.map((r) => (
              <button
                key={r}
                role="option"
                aria-selected={r === selected}
                onClick={() => {
                  onSelect(r)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Flag country={r} className="size-3.5" />
                {r}
                <span className="tnum ml-auto text-muted-foreground">{countOf(r)}</span>
                {r === selected && <Check className="size-3" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
