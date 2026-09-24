import { useEffect, useState } from "react"
import { Fingerprint } from "lucide-react"

import { cn } from "@/lib/utils"

/** Where the visitor's address comes from: two public echoes, no key. ip.sb
 *  answers with CORS anywhere; ipinfo.io answers if the first is unreachable. */
const SOURCES = [
  () => fetch("https://api.ip.sb/ip").then((r) => r.text()),
  () => fetch("https://ipinfo.io/ip").then((r) => r.text()),
]

// Asked once per tab: the address does not change while the page is open.
async function visitorIp(): Promise<string | null> {
  try {
    const hit = sessionStorage.getItem("ip")
    if (hit) return hit
  } catch {
    // Storage unreadable: fall through and ask.
  }
  for (const ask of SOURCES) {
    try {
      const text = await Promise.race([
        ask(),
        new Promise<never>((_, refuse) => setTimeout(() => refuse(new Error("timeout")), 3000)),
      ])
      const ip = text.trim()
      // An error page or a captive portal's greeting is not an address.
      if (/^[0-9a-fA-F:.]{3,45}$/.test(ip)) {
        try {
          sessionStorage.setItem("ip", ip)
        } catch {
          // Private mode: showing it once is enough.
        }
        return ip
      }
    } catch {
      // This echo is unreachable; the next one gets to answer.
    }
  }
  return null
}

/**
 * The visitor's own address, as a capsule that rises from the page's foot for a
 * few seconds and sinks again -- the greeting the reference site pays its
 * visitors. Nothing shows when no echo answered: an absent capsule asserts
 * nothing, a wrong one would.
 */
export function IpCapsule() {
  const [ip, setIp] = useState("")
  const [shown, setShown] = useState(false)
  useEffect(() => {
    let active = true
    let sink: ReturnType<typeof setTimeout> | undefined
    visitorIp().then((found) => {
      if (!active || !found) return
      setIp(found)
      setShown(true)
      sink = setTimeout(() => setShown(false), 6000)
    })
    return () => {
      active = false
      if (sink) clearTimeout(sink)
    }
  }, [])
  if (!ip) return null
  return (
    <div
      role="status"
      className={cn(
        "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border bg-background/80 px-4 py-2 text-xs shadow-lg backdrop-blur transition-all duration-700",
        shown ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-3 opacity-0",
      )}
    >
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Fingerprint className="size-3.5" />
        访客 IP
        <span className="tnum font-medium text-foreground">{ip}</span>
      </span>
    </div>
  )
}
