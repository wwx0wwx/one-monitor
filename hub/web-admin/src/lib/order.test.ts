import { expect, test } from "vitest"
import { moveIds, visibleNeighbour } from "./order.ts"

// The shape of the hidden-node bug: a full order of four, a group filter
// showing three of them, and a move whose indices must both land in the full
// array. ids stand for nodes; 4 is the one the filter hides.
const full = [4, 1, 2, 3]

test("a move's indices both land in the full array", () => {
  expect(moveIds(full, 1, 2)).toEqual([4, 2, 1, 3]) // one down, over its neighbour
  expect(moveIds(full, 1, 3)).toEqual([4, 2, 3, 1]) // to the end, past two
  expect(moveIds(full, 2, 0)).toEqual([2, 4, 1, 3]) // up over the hidden node
})

test("no-ops and out-of-range moves change nothing and say so", () => {
  for (const [from, to] of [[0, 0], [1, 1], [-1, 0], [0, -1], [0, 4], [5, 0]] as const) {
    expect(moveIds(full, from, to)).toBe(null)
  }
})

test("the input is never mutated: the table keeps rendering from it while the move previews", () => {
  const before = [...full]
  moveIds(full, 0, 3)
  expect(full).toEqual(before)
})

test("a keyboard move lands on the neighbouring visible row", () => {
  // Two groups, g1 and g2, sharing one order: [a(g1), b(g2), c(g1)], the
  // filter showing g1's [a, c].
  const nodes = [
    { id: 1, name: "a", group: "g1" },
    { id: 2, name: "b", group: "g2" },
    { id: 3, name: "c", group: "g1" },
  ]
  const g1 = nodes.filter((n) => n.group === "g1")
  // Down from `a` crosses the hidden `b` and lands on `c`: one keypress, one
  // visible change -- the old full-order neighbour (`b`) moved something the
  // operator could not see.
  expect(visibleNeighbour(nodes, g1, 1, 1)).toEqual({ from: 0, to: 2 })
  expect(visibleNeighbour(nodes, g1, 3, -1)).toEqual({ from: 2, to: 0 })
  // At the visible edges there is nothing to move past, hidden rows included.
  expect(visibleNeighbour(nodes, g1, 1, -1)).toBe(null)
  expect(visibleNeighbour(nodes, g1, 3, 1)).toBe(null)
  // Without a filter the visible list is the order, and the answers are the
  // plain neighbouring positions.
  expect(visibleNeighbour(nodes, nodes, 2, -1)).toEqual({ from: 1, to: 0 })
  expect(visibleNeighbour(nodes, nodes, 2, 1)).toEqual({ from: 1, to: 2 })
  // A row the filter does not show has no seat to move from.
  expect(visibleNeighbour(nodes, g1, 2, 1)).toBe(null)
})
