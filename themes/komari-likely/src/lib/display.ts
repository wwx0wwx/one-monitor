/** What the status page shows, as the operator set it on the hub. /api/me
 *  carries the keys as raw strings; this is the shape the page renders from,
 *  with the defaults of a hub that never heard of any of them -- which is also
 *  what the page looked like before any of this existed. */
export type Bg = {
  enabled: boolean
  desktop: string
  mobile: string
  opacity: number
  blur: number
  fit: "cover" | "contain"
  /** Where `fit` crops from: a portrait's head lives at `top`. */
  position: "center" | "top" | "bottom" | "left" | "right"
  /** How solid the frosted panels are while the picture is on: 100 is an
   *  opaque card, and at the bottom of the range the picture reads plainly
   *  through -- the operator's call, paired with `cardBlur` for how smeared
   *  what shows through is. */
  cardOpacity: number
  cardBlur: number
}

export type Display = {
  costPublic: boolean
  busiest: boolean
  swap: boolean
  speed: boolean
  billing: boolean
  ipCapsule: boolean
  expiring: boolean
  region: boolean
}

export type Layout = {
  /** The page's max width in px; wider screens get more cards per row. */
  contentWidth: number
  /** A picture beside the site name; empty shows the name alone. */
  logo: string
}

export type ThemeSettings = { bg: Bg; display: Display; layout: Layout }

const flag = (raw: Record<string, string> | undefined, key: string, fallback: boolean) =>
  (raw?.[key] ?? (fallback ? "on" : "off")) === "on"

/** A raw string as a number, defaulting only on absence or nonsense -- `||`
 *  would be wrong here because 0 is a setting the operator can deliberately
 *  choose, and falsy 0 would fall to the default instead of standing. */
const num = (raw: Record<string, string> | undefined, key: string, fallback: number) => {
  const v = Number(raw?.[key])
  return Number.isFinite(v) ? v : fallback
}

export function parseThemeSettings(raw?: Record<string, string>): ThemeSettings {
  return {
    bg: {
      enabled: (raw?.bg_enabled ?? "off") === "on",
      desktop: raw?.bg_desktop ?? "",
      mobile: raw?.bg_mobile ?? "",
      opacity: Math.min(1, Math.max(0, num(raw, "bg_opacity", 100) / 100)),
      blur: Math.min(20, Math.max(0, num(raw, "bg_blur", 0))),
      fit: raw?.bg_fit === "contain" ? "contain" : "cover",
      position: (["center", "top", "bottom", "left", "right"] as const).includes(
          raw?.bg_position as never,
        )
        ? (raw?.bg_position as Bg["position"])
        : "center",
      cardOpacity: Math.min(100, Math.max(0, num(raw, "card_opacity", 70))),
      cardBlur: Math.min(64, Math.max(0, num(raw, "card_blur", 64))),
    },
    layout: {
      contentWidth: Math.min(2560, Math.max(1000, num(raw, "content_width", 1400))),
      logo: raw?.logo_url ?? "",
    },
    display: {
      costPublic: flag(raw, "cost_public", false),
      busiest: flag(raw, "show_busiest", true),
      swap: flag(raw, "show_swap", true),
      speed: flag(raw, "show_speed", true),
      billing: flag(raw, "show_billing", true),
      ipCapsule: flag(raw, "ip_capsule", true),
      expiring: flag(raw, "expiring_group", true),
      region: flag(raw, "region_group", true),
    },
  }
}
