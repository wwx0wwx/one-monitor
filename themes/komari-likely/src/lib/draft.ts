/**
 * The follow rule for inputs that hold a local draft and commit it on blur,
 * kept as a pure function so the bug it exists for can be regression-tested
 * without a DOM: the saved value is controlled by the caller and can move
 * under the field -- 「恢复默认」 emptying every link, a save made from the
 * hub's own theme tab -- and a draft seeded once at mount then stays behind,
 * leaving the box showing the old value while the next blur quietly PUTs it
 * back to the server.
 *
 * Returns what the field should display: the fresh value once it has moved,
 * the draft otherwise, so typing in progress survives a save that changed
 * nothing. The caller must re-run this whenever `value` differs from the
 * `saved` it last acknowledged -- including when the draft happens to equal
 * the fresh value, or the acknowledgment falls behind and a later move back
 * to the stale spot reads as "no movement".
 */
export function followCommitted(draft: string, saved: string, value: string): string {
  return saved === value ? draft : value
}
