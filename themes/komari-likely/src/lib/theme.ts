/**
 * The one explicit choice of scheme, as the toggle in the header stores it.
 *
 * Not `theme`, the key earlier versions wrote: they wrote it on every visit,
 * with whatever scheme the page happened to open in, so it holds a value for
 * every visitor who ever arrived -- and "跟随系统" (the README's promise) was
 * true of each visitor's first visit only, the scheme of that visit standing
 * in for a choice nobody made. That key cannot tell a choice from a first
 * visit, so it is not read at all: ignoring it releases the visitors who never
 * chose, and whoever did choose, in a version that wrote there, chooses once
 * more. Nothing is written until the toggle is used.
 */
export const THEME_CHOICE = "theme-choice"

/**
 * The scheme `stored` names, or null when it names none and the system's own
 * preference decides -- which is also the answer for any value this theme did
 * not write: another theme's, an older key's, a corrupted one.
 */
export function chosenDark(stored: string | null): boolean | null {
  return stored === "dark" ? true : stored === "light" ? false : null
}
