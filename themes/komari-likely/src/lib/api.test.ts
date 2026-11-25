import { expect, test } from "vitest"
import { api, safeNodes, type Node } from "./api.ts"

const node = { id: 1, metrics: { uptime: 100, cpu: 1, load: [0.1, 0.2, 0.3],
  mem_total: 1024, mem_used: 512, swap_total: 0, swap_used: 0, disk_total: 2048, disk_used: 1024,
  net_rx: 10, net_tx: 20, total_rx: 100, total_tx: 200, month_rx: 50, month_tx: 100,
  tcp: 3, udp: 4, procs: 20 } } as Node

test("a valid node passes through as the same object", () => {
  expect(safeNodes([node])[0]).toBe(node)
})

test("invalid live reports are isolated", () => {
  for (const patch of [{ load: null }, { load: [1, "bad", 3] }, { cpu: "bad" }, { net_rx: Infinity }]) {
    const bad = { ...node, metrics: { ...node.metrics, ...patch } } as unknown as Node
    const result = safeNodes([bad, node])
    expect(result[0].metrics).toBe(null)
    expect(result[1]).toBe(node)
  }
})

// What fetch rejects with when there is no route to the hub: a TypeError with
// the browser's own English message. The page says it in its own words.
test("a request that cannot reach the hub says so, in the page's language", async () => {
  const fetch_ = globalThis.fetch
  globalThis.fetch = (async () => { throw new TypeError("Failed to fetch") }) as typeof fetch
  try {
    await expect(api("/me")).rejects.toMatchObject({ status: 0, message: "连不上服务器：网络断了，或服务器没有响应" })
  } finally {
    globalThis.fetch = fetch_
  }
})
