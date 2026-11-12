/** The order ids take when one of them moves from one position to another,
 * or null when the move is a no-op or out of range.
 *
 * Extracted from the table it serves because it is the exact arithmetic that
 * once reordered by a filtered list's indices while splicing the full one --
 * the hidden-node bug -- and a pure function is where that regression can be
 * pinned by tests that need no browser.
 *
 * Both indices belong to the same array, whatever the caller renders them
 * from: callers computing one side against a filtered view and the other
 * against the full list are the bug this file exists to keep from coming back.
 */
export function moveIds<T>(items: T[], from: number, to: number): T[] | null {
  // Both bounds on both indices: a `from` past the end would splice nothing
  // and hand back the input as if a move had happened.
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to)
    return null
  const next = [...items]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}
