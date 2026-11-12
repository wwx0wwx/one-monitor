/// <reference types="node" />
import assert from "node:assert/strict"
import { addresses, ApiError, changes, GIB, provisioningSite, trafficCorrection, upload } from "./api.ts"

assert.deepEqual(changes({ public: true, price: 5 }, { price: 20 }), { price: 20 })
assert.deepEqual(changes({ total_rx: "100", month_tx: "2" }, { total_rx: "100", month_tx: "3" }), { month_tx: "3" })
assert.deepEqual(changes({ expires_at: "2030-01-01" as string | null }, { expires_at: null }), { expires_at: null })
assert.equal(provisioningSite("https://monitor.example.com:8443/"), "https://monitor.example.com:8443")
for (const site of ["http://monitor.example.com", "https://127.0.0.1", "https://[::1]", "https://2130706433", "https://0x7f000001", "https://localhost", "https://user@monitor.example.com", "https://monitor.example.com/path"]) {
  assert.equal(provisioningSite(site), "", site)
}
// An emptied traffic field means the counter is not to be corrected. Sent as 0
// it would clear a lifetime total, which must never decrease.
const shown = { total_rx: "1.5", total_tx: "2", month_rx: "0.25", month_tx: "1" }
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "" }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "   " }), {})
assert.deepEqual(trafficCorrection(shown, { ...shown, total_rx: "0" }), { total_rx: 0 })
assert.deepEqual(trafficCorrection(shown, { ...shown, total_tx: "3" }), { total_tx: 3 * GIB })
assert.deepEqual(trafficCorrection(shown, shown), {})
// NAT: the public address the connection arrived from leads the private interface.
assert.deepEqual(addresses({ ip: "203.0.113.7", ipv4: "10.10.2.250", ipv6: "2001:db8::1" }), ["203.0.113.7", "10.10.2.250", "2001:db8::1"])
assert.deepEqual(addresses({ ip: "203.0.113.7", ipv4: "100.64.0.9" }), ["203.0.113.7", "100.64.0.9"])
// Hub on the same network, or on the same machine: the connection says nothing more.
assert.deepEqual(addresses({ ip: "192.168.1.2", ipv4: "192.168.1.5" }), ["192.168.1.5"])
assert.deepEqual(addresses({ ip: "127.0.0.1", ipv4: "172.16.0.5" }), ["172.16.0.5"])
// A public interface, or a connection over IPv6, stays as reported.
assert.deepEqual(addresses({ ip: "198.51.100.1", ipv4: "203.0.113.7" }), ["203.0.113.7"])
assert.deepEqual(addresses({ ip: "2001:db8::2", ipv4: "10.0.0.2", ipv6: "2001:db8::2" }), ["10.0.0.2", "2001:db8::2"])
assert.deepEqual(addresses({ ip: "203.0.113.7" }), ["203.0.113.7"])
// Without a recorded connection the list holds only what the agent reported.
assert.deepEqual(addresses({ ipv4: "10.0.0.2" }), ["10.0.0.2"])
assert.deepEqual(addresses({}), [])
console.log("partial edits, traffic corrections, provisioning and address checks passed")

// Chunk retries, against a fake POST and a sleep that returns at once. The
// hub's receive() only appends a piece that begins where the file on disk
// ends, so a retried chunk always re-aligns -- what these exercise is the
// client's side of that bargain: same offset resent, transient faults ridden
// out, verdicts on the request itself accepted on first sight.
{
  const file = new File([new Uint8Array(8)], "backup.db")
  const reply = (status: number) => new Response(status === 200 ? '{"received":8}' : "", { status })
  const nowait = () => Promise.resolve()

  // First POST dies on the network, second is answered 500, third lands:
  // both retryable kinds, still one completed upload.
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls === 1) throw new TypeError("fetch failed")
    return reply(calls === 2 ? 500 : 200)
  }
  assert.deepEqual(await upload("/db/restore", file, undefined, undefined, flaky, nowait), { received: 8 })
  assert.equal(calls, 3)

  // A 413 is the proxy's own answer; resending the same bytes cannot change it.
  let seen = 0
  const rejected = async () => {
    seen++
    return reply(413)
  }
  await assert.rejects(
    () => upload("/db/restore", file, undefined, undefined, rejected, nowait),
    (e: Error) => e instanceof ApiError && e.status === 413,
  )
  assert.equal(seen, 1)

  // Three network failures in a row exhaust the retries and surface the error.
  calls = 0
  const dead = async () => {
    calls++
    throw new TypeError("fetch failed")
  }
  await assert.rejects(
    () => upload("/db/restore", file, undefined, undefined, dead, nowait),
    (e: Error) => e instanceof TypeError,
  )
  assert.equal(calls, 3)
}
console.log("upload chunk retry checks passed")
