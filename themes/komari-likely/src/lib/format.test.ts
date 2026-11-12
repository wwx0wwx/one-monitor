// Every figure on the page passes through this file, making it the one place
// worth a check. Run it with `npm test`: vitest transforms the TypeScript, so
// a distro Node with no built-in type stripping still runs it as is.
//
// Nothing imports it, so the bundle never includes it.
import { expect, test } from "vitest"
import { axisBytes, axisTop, bytes, cpuName, daysUntil, osName, pair, quarters, timeTicks, uptime } from "./format.ts"

test("bytes: the significant-digit ladder, and the sub-byte case that would otherwise print \"512 undefined\"", () => {
  expect(bytes(0)).toBe("0 B") // bytes(0)
  expect(bytes(0.5)).toBe("0 B") // 不能落到 UNITS[-1]
  expect(bytes(-1)).toBe("0 B") // 负数
  expect(bytes(1023)).toBe("1023 B") // 在 B 档不带小数
  expect(bytes(1024)).toBe("1.00 KB") // 1 KiB
  expect(bytes(10 * 1024)).toBe("10.0 KB") // 两位数留一位小数
  expect(bytes(100 * 1024)).toBe("100 KB") // 三位数不留小数
  expect(bytes(1024, 1)).toBe("1.0 KB") // digits 覆盖默认档位
})

test("pair: one unit when both sides share it, two when they do not", () => {
  expect(pair(300 * 1024 ** 2, 900 * 1024 ** 2)).toBe("300.00 / 900.00 MB") // 同单位只写一次
  expect(pair(300 * 1024 ** 2, 3 * 1024 ** 3)).toBe("300 MB / 3.00 GB") // 跨单位各写各的
})

test("axisBytes: ticks under three digits keep one decimal, and a trailing .0 adds nothing", () => {
  expect(axisBytes(3.2 * 1024 ** 3)).toBe("3.2 GB") // 窄轴刻度保留一位
  expect(axisBytes(2 * 1024 ** 3)).toBe("2 GB") // 整数刻度不写 .0
  expect(axisBytes(0)).toBe("0 B") // 零刻度
})

test("axisTop: the top is derived from a round gridline, so quarters() lands on round values", () => {
  expect(axisTop(0.4, 4, 10, 100)).toBe(4) // 闲置机器拿到地板值
  expect(axisTop(63, 4, 10, 100)).toBe(80) // 63% -> 0/20/40/60/80
  expect(axisTop(200, 4, 10, 100)).toBe(100) // 百分比封顶
  expect(axisTop(25_000_000, 1024, 1024)).toBe(32 * 1024 ** 2) // 字节轴按 1024 取整
  expect(quarters(32 * 1024 ** 2).map(axisBytes)).toEqual(["0 B", "8 MB", "16 MB", "24 MB", "32 MB"]) // 四条网格线都是整值
  // 四条刻度为 step·[1,2,3,4]，约束落在第三条：3m 必须能被 axisBytes 精确打印，
  // 而它只保留一位小数。2 的幂均满足；半档 384 与 768 不满足，其第三条刻度为
  // 1.125 Ki 与 2.25 Ki，将被打印为 "1.1" 与 "2.3"。这两档恰好覆盖 1–1.5 MB/s
  // 与 2–3 MB/s。断言针对标签本身，仅比较轴顶比例无法发现该问题。
  expect(quarters(axisTop(2_621_440, 1024, 1024)).map(axisBytes))
    .toEqual(["0 B", "1 MB", "2 MB", "3 MB", "4 MB"]) // 峰值 2.5 MB/s 的四条刻度
  expect(quarters(axisTop(1_258_291, 1024, 1024)).map(axisBytes))
    .toEqual(["0 B", "512 KB", "1 MB", "1.5 MB", "2 MB"]) // 峰值 1.2 MB/s 的四条刻度
  // 轴顶必须取自梯子而非数据本身。十进制梯子配合 1024 进制的 scale 最大仅到
  // 10·1024^k，越过该档后 find 落空，`?? target` 将轴顶回退为 max，网格线随之变为
  // max/4 这类非整值，正是本函数要避免的情形。该回退仅在 [4,40)·1024^k 的窄带内
  // 不出问题，而 40 KB/s–4 MB/s 恰是 VPS 最常见的区间。
  for (const max of [3_000, 300_000, 3_000_000, 300_000_000]) {
    const top = axisTop(max, 1024, 1024)
    expect(top > max).toBe(true) // 轴顶不能等于数据本身
    // 上界为 2 而非 1.5：梯子移除半档后，最坏情况是下一档 2 的幂。
    expect(top / max < 2).toBe(true) // 轴顶不能浪费整块面板
  }
})

test("timeTicks: round clock values phased on local midnight, never more than requested", () => {
  const day = 86_400_000
  const to = Date.now()
  const ticks = timeTicks(to - day, to)
  expect(ticks.length <= 8).toBe(true) // 24 小时窗最多 8 个刻度
  expect(
    ticks.every((t) => new Date(t).getMinutes() === 0 && new Date(t).getSeconds() === 0),
  ).toBe(true) // 刻度落在整点上
  expect(
    ticks.every((t, i) => i === 0 || t - ticks[i - 1] === ticks[1] - ticks[0]),
  ).toBe(true) // 刻度间距均匀
  expect(timeTicks(to, to - day)).toEqual([]) // 反向区间不产出刻度
})

test("daysUntil: whole days, negative once past, null when there is no date", () => {
  const at = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  }
  expect(daysUntil(at(10))).toBe(10) // 十天后
  expect(daysUntil(at(-3))).toBe(-3) // 已过期为负
  expect(daysUntil(null)).toBe(null) // 无到期日
  expect(daysUntil("不是日期")).toBe(null) // 无法解析的日期
})

test("uptime: from a bare minute up to days, dropping the finer unit as it stops mattering", () => {
  expect(uptime(0)).toBe("—") // 没上报过就不写时长
  expect(uptime(90)).toBe("1 分") // 不足一小时
  expect(uptime(3 * 3600 + 25 * 60)).toBe("3 小时 25 分") // 不足一天
  expect(uptime(2 * 86400 + 5 * 3600)).toBe("2 天 5 小时") // 超过一天不再写分钟
})

test("osName and cpuName drop the vendor noise", () => {
  expect(osName("Debian GNU/Linux 12 (bookworm)")).toBe("Debian 12") // 发行版名去掉代号
  expect(cpuName("Intel(R) Xeon(R) CPU E5-2680 8-Core Processor")).toBe("Intel Xeon E5-2680") // CPU 名去掉商标和核数
})
