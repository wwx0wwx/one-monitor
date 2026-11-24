import { expect, test } from "vitest"

import { appliedFilter } from "./filter.ts"

// The regression this file guards: `?group=` naming a filter the page no
// longer offers filtered every server out, and the empty list read as a site
// with no servers at all.

test("a filter the page offers is the one applied", () => {
  const offered = (name: string) => ["g1", "JP", "即将到期"].includes(name)
  expect(appliedFilter("g1", offered)).toBe("g1")
  expect(appliedFilter("JP", offered)).toBe("JP")
  expect(appliedFilter("即将到期", offered)).toBe("即将到期")
  // No filter asked for: every machine.
  expect(appliedFilter("", offered)).toBe("")
})

test("one that names no pill on the page is dropped, for every machine instead", () => {
  // A link to a group since renamed or removed.
  expect(appliedFilter("old-group", (name) => name === "g1")).toBe("")
  // A country picked while region grouping was on, read after it was switched off.
  expect(appliedFilter("JP", () => false)).toBe("")
  // The expiring filter with its pill switched off, or nothing expiring.
  expect(appliedFilter("即将到期", () => false)).toBe("")
})
