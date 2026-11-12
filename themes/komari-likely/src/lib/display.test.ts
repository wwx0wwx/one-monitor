import { expect, test } from "vitest"
import { parseThemeSettings } from "./display.ts"

// The visitor-IP capsule is off unless the operator asks for it: on, the
// theme's browser tells api.ip.sb every visitor's address. The default is
// tested from a missing key -- what a fresh hub sends -- because that is the
// path the hub's own default decides, and from an explicit choice, because
// that is the path the operator's toggle writes.
test("the visitor-IP capsule is off unless the operator asks for it", () => {
  expect(parseThemeSettings({}).display.ipCapsule).toBe(false) // a missing key is off
  expect(parseThemeSettings({ ip_capsule: "on" }).display.ipCapsule).toBe(true) // an explicit on stays on
  expect(parseThemeSettings({ ip_capsule: "off" }).display.ipCapsule).toBe(false) // an explicit off stays off
})

// Clamp guards for the numeric display keys, so a hand-edited row cannot push
// a slider's value outside the range the slider itself enforces.
test("numeric display keys clamp to the range their slider enforces", () => {
  const clamped = parseThemeSettings({ bg_opacity: "500", card_blur: "-40", content_width: "99999" })
  expect(clamped.bg.opacity).toBe(1) // bg_opacity clamps to at most 100%
  expect(clamped.bg.cardBlur).toBe(0) // card_blur clamps to at least 0
  expect(clamped.layout.contentWidth).toBe(2560) // content_width clamps to its ceiling
})
