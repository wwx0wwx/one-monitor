// How often a detail page asks for its window again while it is open. The
// figures above the charts move every couple of seconds; without this the
// charts stayed at the window opened with, and a spike that began afterwards
// was invisible until a reload or a change of range.
export const CHART_REFRESH_MS = 10_000

// The hub builds a handful of history windows at once and answers the next
// with 503 rather than queueing it. A refresh that was refused and asks again
// as soon as it would have is what keeps them occupied, so each one that does
// not get through waits twice as long, up to this; one that does puts the ten
// seconds back.
export const LONGEST_REFRESH_MS = 60_000

/** The wait before the next refresh: the last one, and whether it got through. */
export function nextRefreshWait(after: number, gotThrough: boolean): number {
  return gotThrough ? CHART_REFRESH_MS : Math.min(after * 2, LONGEST_REFRESH_MS)
}
