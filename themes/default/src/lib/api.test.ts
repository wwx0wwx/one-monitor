import { expect, test, vi } from "vitest"
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

// The hub answers in milliseconds. A request still pending at fifteen seconds
// was dropped somewhere on the way, and the page has to say so rather than
// wait on the browser's own limits.
test("a request still pending after fifteen seconds is given up on, and said so", async () => {
  vi.useFakeTimers()
  const fetch_ = globalThis.fetch
  globalThis.fetch = ((_path: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })) as typeof fetch
  try {
    const pending = api("/nodes")
    await vi.advanceTimersByTimeAsync(14_999)
    let settled = false
    void pending.then(() => (settled = true), () => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).rejects.toMatchObject({ status: 0, message: "请求超时" })
  } finally {
    globalThis.fetch = fetch_
    vi.useRealTimers()
  }
})

test("an answer that arrives in time is never aborted, and leaves no timer behind", async () => {
  vi.useFakeTimers()
  const fetch_ = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ nodes: [] }), { status: 200 })) as typeof fetch
  try {
    expect(await api("/nodes")).toEqual({ nodes: [] })
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    globalThis.fetch = fetch_
    vi.useRealTimers()
  }
})

test("a failure with no body and no reason phrase still names its status", async () => {
  // HTTP/2 dropped statusText, so a proxy's bodiless answer arrives as "".
  const fetch_ = globalThis.fetch
  globalThis.fetch = (async () => new Response("", { status: 502 })) as typeof fetch
  try {
    await expect(api("/nodes")).rejects.toMatchObject({ status: 502, message: "HTTP 502" })
  } finally {
    globalThis.fetch = fetch_
  }
})

test("a network failure is passed on as what it is, not reported as a timeout", async () => {
  const fetch_ = globalThis.fetch
  const dropped = new TypeError("Failed to fetch")
  globalThis.fetch = (async () => { throw dropped }) as typeof fetch
  try {
    await expect(api("/nodes")).rejects.toBe(dropped)
  } finally {
    globalThis.fetch = fetch_
  }
})
