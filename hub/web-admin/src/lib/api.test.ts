import { expect, test } from "vitest"
import { addresses, ApiError, changes, GIB, provisioningSite, trafficCorrection, upload } from "./api.ts"

test("changes reports only the keys whose value actually moved", () => {
  expect(changes({ public: true, price: 5 }, { price: 20 })).toEqual({ price: 20 })
  expect(changes({ total_rx: "100", month_tx: "2" }, { total_rx: "100", month_tx: "3" })).toEqual({ month_tx: "3" })
  expect(changes({ expires_at: "2030-01-01" as string | null }, { expires_at: null })).toEqual({ expires_at: null })
})

test("provisioningSite keeps only a plain public https origin", () => {
  expect(provisioningSite("https://monitor.example.com:8443/")).toBe("https://monitor.example.com:8443")
  // Every other shape -- wrong scheme, loopback in any spelling, userinfo, a
  // path -- is refused with an empty string.
  for (const site of ["http://monitor.example.com", "https://127.0.0.1", "https://[::1]", "https://2130706433", "https://0x7f000001", "https://localhost", "https://user@monitor.example.com", "https://monitor.example.com/path"]) {
    expect(provisioningSite(site)).toBe("")
  }
})

test("an emptied traffic field means the counter is not to be corrected", () => {
  // Sent as 0 it would clear a lifetime total, which must never decrease.
  const shown = { total_rx: "1.5", total_tx: "2", month_rx: "0.25", month_tx: "1" }
  expect(trafficCorrection(shown, { ...shown, total_rx: "" })).toEqual({})
  expect(trafficCorrection(shown, { ...shown, total_rx: "   " })).toEqual({})
  expect(trafficCorrection(shown, { ...shown, total_rx: "0" })).toEqual({ total_rx: 0 })
  expect(trafficCorrection(shown, { ...shown, total_tx: "3" })).toEqual({ total_tx: 3 * GIB })
  expect(trafficCorrection(shown, shown)).toEqual({})
})

test("addresses: the NAT arrival address leads the private interface", () => {
  expect(addresses({ ip: "203.0.113.7", ipv4: "10.10.2.250", ipv6: "2001:db8::1" })).toEqual(["203.0.113.7", "10.10.2.250", "2001:db8::1"])
  expect(addresses({ ip: "203.0.113.7", ipv4: "100.64.0.9" })).toEqual(["203.0.113.7", "100.64.0.9"])
  // Hub on the same network, or on the same machine: the connection says nothing more.
  expect(addresses({ ip: "192.168.1.2", ipv4: "192.168.1.5" })).toEqual(["192.168.1.5"])
  expect(addresses({ ip: "127.0.0.1", ipv4: "172.16.0.5" })).toEqual(["172.16.0.5"])
  // A public interface, or a connection over IPv6, stays as reported.
  expect(addresses({ ip: "198.51.100.1", ipv4: "203.0.113.7" })).toEqual(["203.0.113.7"])
  expect(addresses({ ip: "2001:db8::2", ipv4: "10.0.0.2", ipv6: "2001:db8::2" })).toEqual(["10.0.0.2", "2001:db8::2"])
  expect(addresses({ ip: "203.0.113.7" })).toEqual(["203.0.113.7"])
  // Without a recorded connection the list holds only what the agent reported.
  expect(addresses({ ipv4: "10.0.0.2" })).toEqual(["10.0.0.2"])
  expect(addresses({})).toEqual([])
})

// Chunk retries, against a fake POST and a sleep that returns at once. The
// hub's receive() only appends a piece that begins where the file on disk
// ends, so a retried chunk always re-aligns -- what these exercise is the
// client's side of that bargain: same offset resent, transient faults ridden
// out, verdicts on the request itself accepted on first sight.
const file = new File([new Uint8Array(8)], "backup.db")
const reply = (status: number) => new Response(status === 200 ? '{"received":8}' : "", { status })
const nowait = () => Promise.resolve()

test("both kinds of transient fault are ridden out to one completed upload", async () => {
  // First POST dies on the network, second is answered 500, third lands:
  // both retryable kinds, still one completed upload.
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls === 1) throw new TypeError("fetch failed")
    return reply(calls === 2 ? 500 : 200)
  }
  expect(await upload("/db/restore", file, undefined, undefined, flaky, nowait)).toEqual({ received: 8 })
  expect(calls).toBe(3)
})

test("a 413 is the proxy's own answer; resending the same bytes cannot change it", async () => {
  let seen = 0
  const rejected = async () => {
    seen++
    return reply(413)
  }
  await expect(upload("/db/restore", file, undefined, undefined, rejected, nowait)).rejects.toSatisfy(
    (e: Error) => e instanceof ApiError && e.status === 413,
  )
  expect(seen).toBe(1)
})

test("three network failures in a row exhaust the retries and surface the error", async () => {
  let calls = 0
  const dead = async () => {
    calls++
    throw new TypeError("fetch failed")
  }
  await expect(upload("/db/restore", file, undefined, undefined, dead, nowait)).rejects.toSatisfy(
    (e: Error) => e instanceof TypeError,
  )
  expect(calls).toBe(3)
})
