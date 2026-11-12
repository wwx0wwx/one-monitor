import { expect, test } from "vitest"

import { followCommitted } from "./draft.ts"

// The regression this file guards: a controlled value that moves under a
// blur-committing field must carry the draft with it. 「恢复默认」 emptying a
// saved link (or the hub's theme tab rewriting it) used to leave the input
// showing the old value, and the next blur committed that stale draft right
// back to the server.
test("a controlled value that moved resets the draft", () => {
  expect(followCommitted("https://old.png", "https://old.png", "")).toBe("") // 恢复默认清空后草稿跟随为空
  expect(followCommitted("https://old.png", "https://old.png", "https://new.png")).toBe("https://new.png") // 后台另存后草稿跟随新值
})

// The other half of the rule: while the saved value stands still, the draft
// is the user's half-typed edit and must survive -- otherwise every unrelated
// re-render or no-op save would wipe the box mid-typing.
test("a draft in progress survives a saved value that has not moved", () => {
  expect(followCommitted("https://draf", "https://old.png", "https://old.png")).toBe("https://draf") // 值未前进时保留正在输入的草稿
  expect(followCommitted("", "", "")).toBe("") // 全空时也成立
})
