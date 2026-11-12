// The main path, end to end: a fresh hub, the public page, sign-in, adding a
// node, an agent reporting over the real WebSocket protocol, and the node
// arriving on the status page with its figures -- no release binary needed,
// the "agent" is a small ws client speaking the same JSON-RPC frames.
//
// One piece of staging stands in for production: the browser reaches the hub
// through a tiny TLS-terminating proxy with a self-signed certificate, because
// the panel's provisioning gate admits an https domain only, and a Secure
// session cookie is only honoured over https. The domain is e2e.test, mapped
// to loopback inside the browser itself; nothing here touches /etc/hosts.
//
// Run from hub/:  (cd e2e && npm ci && npx playwright install chromium && npm test)
// CI needs --with-deps on the playwright install for the browser's libraries.

import { spawn, execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import net from "node:net"
import http from "node:http"
import https from "node:https"
import { setTimeout as sleep } from "node:timers/promises"

import { chromium } from "playwright"
import WebSocket from "ws"

const DOMAIN = "e2e.test"

// A port that is free on this machine right now: a fixed number races anything
// else that happens to listen on it (another e2e run, a leftover process), and
// the failure reads as the hub failing to start. Falls upward until one binds.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}
// The two ports must be found before the URL and the hub's --listen are built,
// so both are awaited up front; the browser's origin derives from TLS_PORT.
const [HUB_PORT, TLS_PORT] = await Promise.all([freePort(), freePort()])
const ORIGIN = `https://${DOMAIN}:${TLS_PORT}`

const failed = []
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failed.push(name)
}

const work = mkdtempSync(join(tmpdir(), "monitor-e2e-"))
const hubBin = join(import.meta.dirname, "..", "target", "debug", "monitor-hub")
const db = join(work, "db")
let hub
let proxy
let browser

try {
  // ---- the hub, fresh, and its one-time password file ----
  hub = spawn(hubBin, ["--listen", `127.0.0.1:${HUB_PORT}`, "--db", join(db, "monitor.db"), "--site", ORIGIN], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const hubOut = []
  hub.stdout.on("data", (d) => hubOut.push(d))
  hub.stderr.on("data", (d) => hubOut.push(d))
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${HUB_PORT}/api/me`).then((r) => r.json())
      break
    } catch {
      await sleep(100)
      if (i === 99) throw new Error("hub did not start:\n" + hubOut.join(""))
    }
  }
  const passwordFile = join(db, "initial-password")
  const password = existsSync(passwordFile) ? readFileSync(passwordFile, "utf8").trim() : ""
  check("fresh boot writes the one-time password file", password.length === 24, `${password.length} chars`)
  check("and the journal carries only the pointer", !hubOut.join("").includes(password))

  // ---- the TLS front ----
  const cert = join(work, "e2e-cert.pem")
  const key = join(work, "e2e-key.pem")
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-subj", `/CN=${DOMAIN}`, "-days", "1",
  ])
  const forward = { host: "127.0.0.1", port: HUB_PORT }
  proxy = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const upstream = http.request({ ...forward, path: req.url, method: req.method, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers)
      ur.pipe(res)
    })
    req.pipe(upstream)
  })
  // The agent stream and the live stream both ride the same upgrade.
  proxy.on("upgrade", (req, socket, head) => {
    const upstream = http.request({ ...forward, path: req.url, method: req.method, headers: req.headers })
    upstream.on("upgrade", (ur, usock) => {
      const head2 = [
        `HTTP/1.1 101 Switching Protocols`,
        ...Object.entries(ur.headers).map(([k, v]) => `${k}: ${v}`),
        "\r\n",
      ].join("\r\n")
      socket.write(head2)
      usock.pipe(socket)
      socket.pipe(usock)
    })
    upstream.on("response", () => socket.destroy())
    upstream.end(head)
  })
  await new Promise((r) => proxy.listen(TLS_PORT, "127.0.0.1", r))

  // ---- the browser ----
  browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1`] })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))

  // 1. The public page before anything exists: the empty state and its hint.
  await page.goto(ORIGIN, { waitUntil: "networkidle" })
  const empty = await page.locator("body").innerText()
  check("public page: empty state", empty.includes("还没有服务器"))
  check("public page: and its guidance", empty.includes("登录"))

  // 2. A wrong password is refused in Chinese, and the address stays /admin.
  await page.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" })
  await page.locator("input[type=password]").fill("not-the-password")
  await page.getByRole("button", { name: "登录" }).click()
  await page.waitForTimeout(2500)
  const refused = await page.locator("body").innerText()
  check("sign-in: wrong password refused in Chinese", refused.includes("密码不正确"))
  check("sign-in: the address stays /admin", new URL(page.url()).pathname === "/admin")

  // 3. The one-time password signs in -- and spends the file.
  await page.locator("input[type=password]").fill(password)
  await page.getByRole("button", { name: "登录" }).click()
  await page.waitForURL("**/admin/nodes", { timeout: 15_000 })
  check("sign-in: lands on /admin/nodes", true)
  await sleep(500)
  check("sign-in: removed the one-time password file", !existsSync(passwordFile))

  // 4. A node through the panel; the install dialog reads its token on demand.
  await page.getByRole("button", { name: "添加服务器" }).click()
  await page.locator("[role=dialog] input").first().fill("e2e-main")
  await page.locator("[role=dialog] button", { hasText: "添加" }).last().click()
  await page.waitForTimeout(1200)
  const tokenReply = page.waitForResponse((r) => /\/api\/nodes\/\d+\/token$/.test(r.url()))
  await page.locator('button[aria-label="安装 Agent"]').first().click()
  const token = (await (await tokenReply).json()).token
  check("panel: install dialog reads the token", /^[0-9a-f]{64}$/.test(token))
  await page.keyboard.press("Escape").catch(() => {})
  await page.locator("[role=dialog] button", { hasText: "关闭" }).click().catch(() => {})

  // 5. An agent: the real protocol over a real socket, reporting 42% CPU.
  const agent = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/api/agent/ws`, {
    headers: { authorization: `Bearer ${token}` },
  })
  await new Promise((r, j) => { agent.once("open", r); agent.once("error", j) })
  agent.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: {
    hostname: "e2e-fake", os: "E2E Linux", kernel: "e2e", arch: "x86_64", virt: "e2e",
    cpu_name: "E2E CPU", cpu_cores: 2, mem_total: 2 * 2 ** 30, swap_total: 0,
    disk_total: 10 * 2 ** 30, agent_version: "e2e-fake",
  } }))
  const gb = 2 ** 30
  // The full report contract, every column the themes display: the default
  // theme voids a node's live view when a single one is missing, which is
  // exactly what a half-fake agent would look like on a real deployment.
  agent.send(JSON.stringify({ jsonrpc: "2.0", method: "report", params: {
    cpu: 42, mem_used: Math.round(0.5 * 2 * gb), mem_total: 2 * gb,
    swap_total: 0, swap_used: 0, disk_used: 2 * gb, disk_total: 10 * gb,
    uptime: 3_600, tcp: 10, udp: 8, procs: 42,
    load: [0.1, 0.1, 0.1], boot_id: "e2e-boot",
    net_rx_total: 1_000, net_tx_total: 2_000, net_rx: 10, net_tx: 20,
  } }))

  // 6. The status page shows it: online, with the figures the agent sent.
  await page.goto(ORIGIN, { waitUntil: "networkidle" })
  await page.waitForTimeout(4000)
  const live = await page.locator("body").innerText()
  check("status page: the node is online", live.includes("e2e-main") && live.includes("在线"))
  check("status page: carrying its own CPU figure", live.includes("42%"))

  // 7. Keyboard order, plain and under a group filter.
  async function addNode(name) {
    await page.goto(`${ORIGIN}/admin/nodes`, { waitUntil: "networkidle" })
    await page.getByRole("button", { name: "添加服务器" }).click()
    await page.locator("[role=dialog] input").first().fill(name)
    await page.locator("[role=dialog] button", { hasText: "添加" }).last().click()
    await page.waitForTimeout(1000)
  }
  async function setGroup(name, group) {
    const row = page.locator("table tbody tr", { hasText: name }).first()
    await row.locator('button[aria-label="编辑服务器"]').click()
    await page.waitForTimeout(600)
    await page.locator("[role=dialog]").locator('input[placeholder="香港"]').fill(group)
    await page.locator("[role=dialog]").getByRole("button", { name: /保存/ }).click()
    await page.waitForTimeout(900)
  }
  const orderViaApi = () =>
    page.evaluate(async () => (await (await fetch("/api/nodes", { credentials: "include" })).json()).nodes.map((n) => n.name))

  await addNode("e2e-b")
  await setGroup("e2e-main", "g1")
  await setGroup("e2e-b", "g1")
  await addNode("e2e-c") // no group: the hidden row the filter sits between

  // No filter: one press swaps the two visible neighbours.
  await page.locator('button[aria-label^="拖动"][aria-label*="e2e-main"]').click()
  await page.keyboard.press("ArrowDown")
  await page.waitForTimeout(1200)
  check("order: plain keyboard move", JSON.stringify(await orderViaApi()) === JSON.stringify(["e2e-b", "e2e-main", "e2e-c"]))

  // Now separate the visible rows with a hidden one: no filter, move e2e-c up
  // between them -- [e2e-b, e2e-c, e2e-main], g1 showing [e2e-b, e2e-main].
  await page.getByRole("button", { name: /^全部/ }).click()
  await page.waitForTimeout(600)
  await page.locator('button[aria-label^="拖动"][aria-label*="e2e-c"]').click()
  await page.keyboard.press("ArrowUp")
  await page.waitForTimeout(1000)
  // Under the group filter, one press on e2e-b crosses the hidden e2e-c and
  // lands beside e2e-main: one keypress, one visible change.
  await page.getByRole("button", { name: /^g1/ }).click()
  await page.waitForTimeout(600)
  await page.locator('button[aria-label^="拖动"][aria-label*="e2e-b"]').click()
  await page.keyboard.press("ArrowDown")
  await page.waitForTimeout(1200)
  check("order: filtered move crosses the hidden row, visibly", JSON.stringify(await orderViaApi()) === JSON.stringify(["e2e-c", "e2e-main", "e2e-b"]))
  const visibleRows = await page.locator("table tbody tr").evaluateAll((rs) => rs.map((r) => r.textContent.slice(0, 8)))
  check("order: and the screen changed with it", visibleRows[0].includes("e2e-main") && visibleRows[1].includes("e2e-b"))

  // 8. Sign-out ends the session.
  await page.getByRole("button", { name: "退出登录" }).click()
  await page.waitForURL(`${ORIGIN}/`, { timeout: 10_000 })
  await page.goto(`${ORIGIN}/admin`, { waitUntil: "networkidle" })
  const again = await page.locator("body").innerText()
  check("sign-out: the panel asks again", again.includes("登录后台"))

  check("no page errors along the way", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "))
} finally {
  await browser?.close().catch(() => {})
  proxy?.close()
  hub?.kill("SIGTERM")
  rmSync(work, { recursive: true, force: true })
}

console.log(failed.length ? `\nE2E FAILED: ${failed.join(", ")}` : "\nE2E main path: all green")
process.exit(failed.length ? 1 : 0)
