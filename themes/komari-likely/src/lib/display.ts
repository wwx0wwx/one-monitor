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
}

export type Display = {
  costPublic: boolean
  swap: boolean
  speed: boolean
  billing: boolean
  ipCapsule: boolean
  expiring: boolean
  region: boolean
}

export type ThemeSettings = { bg: Bg; display: Display }

const flag = (raw: Record<string, string> | undefined, key: string, fallback: boolean) =>
  (raw?.[key] ?? (fallback ? "on" : "off")) === "on"

export function parseThemeSettings(raw?: Record<string, string>): ThemeSettings {
  return {
    bg: {
      enabled: (raw?.bg_enabled ?? "off") === "on",
      desktop: raw?.bg_desktop ?? "",
      mobile: raw?.bg_mobile ?? "",
      opacity: Math.min(1, Math.max(0, Number(raw?.bg_opacity ?? 100) / 100 || 1)),
      blur: Math.min(20, Math.max(0, Number(raw?.bg_blur ?? 0) || 0)),
      fit: raw?.bg_fit === "contain" ? "contain" : "cover",
    },
    display: {
      costPublic: flag(raw, "cost_public", false),
      swap: flag(raw, "show_swap", true),
      speed: flag(raw, "show_speed", true),
      billing: flag(raw, "show_billing", true),
      ipCapsule: flag(raw, "ip_capsule", true),
      expiring: flag(raw, "expiring_group", true),
      region: flag(raw, "region_group", true),
    },
  }
}
