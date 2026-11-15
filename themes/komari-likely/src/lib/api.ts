import { useEffect, useState } from "react"

export type Metrics = {
  uptime: number
  cpu: number
  load: [number, number, number]
  mem_total: number
  mem_used: number
  swap_total: number
  swap_used: number
  disk_total: number
  disk_used: number
  net_rx: number
  net_tx: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  tcp: number
  udp: number
  procs: number
}

export type Node = {
  id: number
  name: string
  sort: number
  public: boolean
  online: boolean
  /** ISO 3166-1 alpha-2, or empty when the hub could not locate the address. */
  country: string
  /** Semicolon-separated badges the operator files the server under. */
  tag: string
  /** Filter dimension; empty means no group. */
  group: string
  last_seen: number
  metrics: Metrics | null
  os: string
  kernel: string
  arch: string
  virt: string
  cpu_name: string
  cpu_cores: number
  mem_total: number
  swap_total: number
  disk_total: number
  agent_version: string
  price: number
  currency: string
  billing_cycle: string
  expires_at: string | null
  traffic_limit: number
  traffic_mode: string
  traffic_reset_day: number
  total_rx: number
  total_tx: number
  month_rx: number
  month_tx: number
  month_start: string
  day_rx: number
  day_tx: number
  /** Panel only. */
  hostname?: string
  ip?: string
  remark?: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * 15s: the hub's endpoints answer in milliseconds, so a request still pending
 * at this mark has been dropped by the network or a proxy on the way. Without
 * a timeout of its own, fetch waits on the browser's TCP limits -- minutes on
 * some stacks -- and the page sits on 「加载中…」 the whole way through. The
 * timer is cleared however the fetch leaves, so a normal response is never
 * aborted, and only this helper's own abort is translated: the engine's
 * AbortError wording would otherwise surface verbatim in the red line the
 * page shows.
 */
const TIMEOUT = 15_000

async function fetchWithTimeout(path: string, init?: RequestInit): Promise<Response> {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), TIMEOUT)
  try {
    return await fetch(path, { ...init, signal: control.signal })
  } catch (e) {
    if (control.signal.aborted) throw new ApiError(0, "请求超时")
    throw e
  } finally {
    clearTimeout(timer)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(`/api${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init?.headers } : init?.headers,
  })
  // `|| \`HTTP ${status}\`` as the last resort: HTTP/2 dropped statusText, so a
  // bodiless failure from a proxy arrives as "" -- and an empty message reads
  // as no error to every caller that checks for one.
  if (!res.ok) throw new ApiError(res.status, (await res.text()) || res.statusText || `HTTP ${res.status}`)
  return res.status === 204 ? (undefined as T) : res.json()
}

/**
 * Fleet throughput, one sample per push. Held beside the stream that feeds it
 * rather than in the tile that draws it: the summary unmounts while a node page is
 * open, so a buffer held there would restart empty on every return. Two minutes at
 * the hub's push interval.
 */
const KEEP = 60
export const speedHistory: { rx: number; tx: number }[] = []

function sample(nodes: Node[]) {
  const live = nodes.filter((n) => n.online && n.metrics)
  speedHistory.push({
    rx: live.reduce((s, n) => s + n.metrics!.net_rx, 0),
    tx: live.reduce((s, n) => s + n.metrics!.net_tx, 0),
  })
  if (speedHistory.length > KEEP) speedHistory.shift()
}

/** A malformed report must not remove every other node from the page. */
export function safeNodes(nodes: Node[]): Node[] {
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0
  const fields = ["uptime", "cpu", "mem_total", "mem_used", "swap_total", "swap_used", "disk_total", "disk_used",
    "net_rx", "net_tx", "total_rx", "total_tx", "month_rx", "month_tx", "tcp", "udp", "procs"] as const
  return nodes.map((node) => {
    const m = node.metrics
    return !m || (fields.every((key) => number(m[key])) && Array.isArray(m.load) && m.load.length === 3 && m.load.every(number))
      ? node : { ...node, metrics: null }
  })
}

/**
 * Live node list. Uses the WebSocket the hub pushes every two seconds, falling
 * back to polling if it cannot be established.
 */
export function useNodes() {
  const [nodes, setNodes] = useState<Node[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Set when the hub answers 401: the status page has been closed to anonymous
  // callers since this tab loaded. The hub also ends the stream, so this surfaces
  // on the fallback fetch the reconnect starts; a close allows a client to
  // re-query its state but cannot compel it.
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    let socket: WebSocket | null = null
    let poll: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const receive = (list: Node[]) => {
      const safe = safeNodes(list)
      sample(safe)
      setNodes(safe)
      setError(null)
      setClosed(false)
    }

    const fetchOnce = () =>
      api<{ nodes: Node[] }>("/nodes")
        .then((d) => receive(d.nodes))
        .catch((e: Error) => {
          setError(e.message)
          if (e instanceof ApiError && e.status === 401) setClosed(true)
        })

    fetchOnce()

    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`
    // A hub restart closes every stream. Without reconnecting, a page that
    // outlives a deploy would remain on the fallback poll for the rest of its
    // life, refreshing at a fifth of the live rate with no indication.
    const connect = () => {
      try {
        socket = new WebSocket(url)
      } catch {
        poll ??= setInterval(fetchOnce, 5000)
        return
      }
      socket.onmessage = (event) => {
        receive(JSON.parse(event.data).nodes)
        // The stream has returned; the poll was only covering for it.
        if (poll) {
          clearInterval(poll)
          poll = null
        }
      }
      socket.onerror = () => socket?.close()
      socket.onclose = () => {
        if (closed) return
        poll ??= setInterval(fetchOnce, 5000)
        retry = setTimeout(connect, 5000)
      }
    }
    connect()

    return () => {
      closed = true
      socket?.close()
      if (poll) clearInterval(poll)
      if (retry) clearTimeout(retry)
    }
  }, [])

  return { nodes, error, closed }
}
