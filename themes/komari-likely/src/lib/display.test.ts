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

// The hub sends unset keys as empty strings, and `Number("")` is 0 -- without
// the guard, an unfilled slider reads as one deliberately set to its floor.
// The same test pins the other half: a real "0" is a choice and stands.
test("an empty value falls back to the default rather than reading as 0", () => {
  const blank = parseThemeSettings({ card_blur: "", bg_opacity: "   ", content_width: "" })
  expect(blank.bg.cardBlur).toBe(64) // 空串走默认，而不是 Number("") 的 0
  expect(blank.bg.opacity).toBe(1) // 纯空白同样视为未填
  expect(blank.layout.contentWidth).toBe(1400)
  expect(parseThemeSettings({ card_blur: "0" }).bg.cardBlur).toBe(0) // 显式的 0 仍然成立
})

// Two things on the page ask someone other than the hub: the flag pictures
// (jsDelivr) and the day's exchange table (jsDelivr, open.er-api.com). Both
// stay on unless the operator switches them off -- the page as it has always
// been -- and off stays off.
test("the flag pictures and the exchange table can be kept from asking a third party", () => {
  expect(parseThemeSettings({}).display.flags).toBe(true) // a missing key is on
  expect(parseThemeSettings({ flags_cdn: "off" }).display.flags).toBe(false)
  expect(parseThemeSettings({}).display.fx).toBe(true)
  expect(parseThemeSettings({ fx_api: "off" }).display.fx).toBe(false)
})
