/// <reference types="node" />
import assert from "node:assert/strict"
import { moveIds } from "./order.ts"

// The shape of the hidden-node bug: a full order of four, a group filter
// showing three of them, and a move whose indices must both land in the full
// array. ids stand for nodes; 4 is the one the filter hides.
const full = [4, 1, 2, 3]
assert.deepEqual(moveIds(full, 1, 2), [4, 2, 1, 3], "one down, over its neighbour")
assert.deepEqual(moveIds(full, 1, 3), [4, 2, 3, 1], "to the end, past two")
assert.deepEqual(moveIds(full, 2, 0), [2, 4, 1, 3], "up over the hidden node")

// No-ops and out-of-range moves change nothing and say so.
for (const [from, to] of [[0, 0], [1, 1], [-1, 0], [0, -1], [0, 4], [5, 0]] as const) {
  assert.equal(moveIds(full, from, to), null, `from ${from} to ${to}`)
}

// The input is never mutated: the table keeps rendering from it while the move
// previews.
const before = [...full]
moveIds(full, 0, 3)
assert.deepEqual(full, before)
console.log("order 校验通过")
