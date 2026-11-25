import { expect, test } from "vitest"
import { CHART_REFRESH_MS, LONGEST_REFRESH_MS, nextRefreshWait } from "./refresh.ts"

test("a refresh that gets through keeps the ten seconds", () => {
  expect(nextRefreshWait(CHART_REFRESH_MS, true)).toBe(CHART_REFRESH_MS)
  // From a long wait too: the page is back to its usual rate.
  expect(nextRefreshWait(LONGEST_REFRESH_MS, true)).toBe(CHART_REFRESH_MS)
})

test("one that does not waits twice as long, up to a minute", () => {
  expect(nextRefreshWait(CHART_REFRESH_MS, false)).toBe(20_000)
  expect(nextRefreshWait(20_000, false)).toBe(40_000)
  expect(nextRefreshWait(40_000, false)).toBe(LONGEST_REFRESH_MS)
  expect(nextRefreshWait(LONGEST_REFRESH_MS, false)).toBe(LONGEST_REFRESH_MS)
})
