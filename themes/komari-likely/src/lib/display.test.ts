/// <reference types="node" />
import assert from "node:assert/strict"
import { parseThemeSettings } from "./display.ts"

// The visitor-IP capsule is off unless the operator asks for it: on, the
// theme's browser tells api.ip.sb every visitor's address. The default is
// tested from a missing key -- what a fresh hub sends -- because that is the
// path the hub's own default decides, and from an explicit choice, because
// that is the path the operator's toggle writes.
assert.equal(parseThemeSettings({}).display.ipCapsule, false, "a missing key is off")
assert.equal(parseThemeSettings({ ip_capsule: "on" }).display.ipCapsule, true, "an explicit on stays on")
assert.equal(parseThemeSettings({ ip_capsule: "off" }).display.ipCapsule, false, "an explicit off stays off")

// Clamp guards for the numeric display keys, so a hand-edited row cannot push
// a slider's value outside the range the slider itself enforces.
const clamped = parseThemeSettings({ bg_opacity: "500", card_blur: "-40", content_width: "99999" })
assert.equal(clamped.bg.opacity, 1, "bg_opacity clamps to at most 100%")
assert.equal(clamped.bg.cardBlur, 0, "card_blur clamps to at least 0")
assert.equal(clamped.layout.contentWidth, 2560, "content_width clamps to its ceiling")

console.log("display 校验通过")
