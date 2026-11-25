"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  // Whether the table is wider than the room it has, and which way there is
  // more of it: on a phone every admin table is, and one that only scrolls
  // sideways gives no other sign of it.
  const box = React.useRef<HTMLDivElement>(null)
  const [more, setMore] = React.useState({ left: false, right: false })
  const measure = React.useCallback(() => {
    const el = box.current
    if (!el) return
    const next = { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 }
    // The same object when nothing moved, or every measure would be a render.
    setMore((old) => (old.left === next.left && old.right === next.right ? old : next))
  }, [])
  React.useEffect(() => {
    const el = box.current
    if (!el) return
    // After layout: no width is known before it.
    const frame = requestAnimationFrame(measure)
    el.addEventListener("scroll", measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    // The table too: a node added or removed moves the edge as much as a
    // window resized does.
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener("scroll", measure)
      observer.disconnect()
    }
  }, [measure])
  const edge = "pointer-events-none absolute inset-y-0 w-10 from-background to-transparent transition-opacity"
  return (
    <div className="relative">
      <div
        ref={box}
        data-slot="table-container"
        className="relative w-full overflow-x-auto"
      >
        <table
          data-slot="table"
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>
      {/* The edge that still hides columns is shaded until it hides none. */}
      <div aria-hidden className={cn(edge, "left-0 bg-gradient-to-r", more.left ? "opacity-100" : "opacity-0")} />
      <div aria-hidden className={cn(edge, "right-0 bg-gradient-to-l", more.right ? "opacity-100" : "opacity-0")} />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        // `group`: a cell pinned to the left edge has to repaint itself in the row's hover colour, since it no longer shows the row through.
        "group border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
