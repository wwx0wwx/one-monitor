import { memo, useState } from "react"

import { cn } from "@/lib/utils"

const FALLBACK = "🌐"

/** ISO 3166-1 alpha-2 to the regional-indicator sequence naming that flag. */
function emojiFor(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return FALLBACK
  const A = 0x1f1e6
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => A + c.charCodeAt(0) - 65))
}

function twemojiUrl(emoji: string): string {
  const name = Array.from(emoji).map((c) => c.codePointAt(0)!.toString(16)).join("-")
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${name}.svg`
}

/**
 * The node's country as a flag. The code stays available as the tooltip: a flag
 * is a guess at a place, the letters are the fact. If the CDN is unreachable the
 * system emoji renders in its place -- a shape either way, a broken image never.
 */
export const Flag = memo(function Flag({ country, className }: { country: string; className?: string }) {
  const [broken, setBroken] = useState(false)
  const emoji = emojiFor(country)
  return (
    <span className={cn("inline-flex size-[18px] shrink-0 items-center justify-center", className)} title={country || undefined}>
      {broken ? (
        <span className="text-sm leading-none" aria-hidden>{emoji}</span>
      ) : (
        <img src={twemojiUrl(emoji)} alt={country || "未知"} className="size-[18px] object-contain" onError={() => setBroken(true)} />
      )}
    </span>
  )
})
