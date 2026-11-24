import { expect, test } from "vitest"

import { chosenDark, THEME_CHOICE } from "./theme.ts"

// The regression this file guards: the page used to save the scheme it opened
// in, so a visitor who never touched the toggle was pinned to the scheme of
// their first visit, and the system preference decided only that one.

test("a stored choice decides the scheme", () => {
  expect(chosenDark("dark")).toBe(true)
  expect(chosenDark("light")).toBe(false)
})

test("nothing stored, or nothing this theme wrote, leaves it to the system", () => {
  // The state of every visitor until their first toggle.
  expect(chosenDark(null)).toBeNull()
  // Earlier versions left a value like these for every visitor under another
  // key; read as a choice they would pin them all over again.
  for (const stored of ["", "banana", "auto", "Dark", "true"]) {
    expect(chosenDark(stored)).toBeNull()
  }
})

test("the choice is not stored under the key every visit used to write", () => {
  // Were it the same key, the values already there -- written without a
  // choice -- would be indistinguishable from the ones made on purpose.
  expect(THEME_CHOICE).not.toBe("theme")
})
