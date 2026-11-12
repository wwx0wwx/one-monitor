import { expect, test } from "vitest"
import { safeNodes, type Node } from "./api.ts"

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
