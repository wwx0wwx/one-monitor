import { useEffect, useState } from "react"

/**
 * The day's published USD table -- never a hand-written approximation. Two
 * public sources, no key: a jsDelivr-hosted daily build (the same CDN the flags
 * come from, and the friendlier one for visitors behind the firewall) with
 * ExchangeRate-API's open endpoint behind it. Both publish daily and agree with
 * each other to the third decimal; either serves alone.
 */
const SOURCES = [
  // { date, usd: { cny: 6.71, ... } } -- lowercase codes, per 1 USD
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
  // { result: "success", rates: { CNY: 6.72, ... } } -- uppercase, per 1 USD
  "https://open.er-api.com/v6/latest/USD",
]

/** A day: the sources refresh daily, and a visitor's tab outliving that is no
 *  reason to keep quoting yesterday's table. */
const KEEP = 24 * 60 * 60 * 1000

type Table = { fetchedAt: number; date: string; usd: Record<string, number> }

function readCache(): Table | undefined {
  try {
    const raw = localStorage.getItem("fx")
    if (!raw) return undefined
    const saved = JSON.parse(raw) as Table
    return Date.now() - saved.fetchedAt < KEEP ? saved : undefined
  } catch {
    return undefined
  }
}

// One load per tab however many detail pages open onto it.
let inflight: Promise<Table | null> | null = null

async function load(): Promise<Table | null> {
  const ask = inflight ??= (async () => {
    for (const url of SOURCES) {
      try {
        const res = await fetch(url)
        if (!res.ok) continue
        const json = await res.json()
        // The two sources name their table's day differently; both are the day
        // the numbers were published, which is what the tooltip owes the reader.
        const usd = url.includes("er-api")
          ? Object.fromEntries(Object.entries(json.rates ?? {}).map(([k, v]) => [k.toLowerCase(), Number(v)]))
          : json.usd
        const date = url.includes("er-api")
          ? (json.time_last_update_unix ? new Date(json.time_last_update_unix * 1000).toISOString().slice(0, 10) : "")
          : String(json.date ?? "")
        if (usd?.cny > 0) {
          const fresh = { fetchedAt: Date.now(), date, usd }
          try {
            localStorage.setItem("fx", JSON.stringify(fresh))
          } catch {
            // Private mode: this tab's memory serves the rest of it.
          }
          return fresh
        }
      } catch {
        // This source is unreachable; the next one gets to answer.
      }
    }
    return null
  })()
  try {
    return await ask
  } finally {
    inflight = null
  }
}

/**
 * The whole table as a hook, for callers with more than one currency to
 * convert. Same three states as [`useCnyRate`].
 */
export function useCnyTable(): Table | null | undefined {
  const [table, setTable] = useState<Table | null | undefined>(readCache)
  useEffect(() => {
    if (table !== undefined) return
    let active = true
    load().then((fresh) => {
      if (active) setTable(fresh)
    })
    return () => {
      active = false
    }
  }, [table])
  return table
}

/** CNY per one unit of `code` from a loaded table; null when the table does
 *  not list the currency. */
export function cnyPer(code: string, table: NonNullable<Table>): number | null {
  if (code === "CNY") return 1
  const perUsd = table.usd[code.toLowerCase()]
  return perUsd && table.usd.cny ? table.usd.cny / perUsd : null
}

/**
 * Units of CNY one unit of `code` buys, with the day the table was published.
 * `rate` is `undefined` while the table is still loading, `null` when no source
 * answered or the table does not list the currency, `1` for CNY itself without
 * touching the network.
 */
export function useCnyRate(code: string): { rate: number | null | undefined; date?: string } {
  const table = useCnyTable()
  if (code === "CNY") return { rate: 1 }
  if (!table) return { rate: table === undefined ? undefined : null }
  return { rate: cnyPer(code, table), date: table.date }
}
