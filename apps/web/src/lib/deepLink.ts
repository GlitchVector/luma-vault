/**
 * Deep links to a set: `…/?set=<run>` opens the library with that set selected.
 *
 * A **query parameter**, not a hash, on purpose. The hash already belongs to the
 * lightbox (App.tsx pushes `#lightbox` so the phone's back gesture closes the
 * picture instead of leaving the app, and strips it on reload). A second writer
 * there would fight that, and a stale `#lightbox` would be indistinguishable
 * from a link someone actually sent. The path never changes, so the LAN server
 * still only ever serves index.html — no routing needed on either side.
 *
 * Run ids contain slashes (`shotall/ari/20260914T1730`) or are already slugged
 * (`shotall-ari-20260914t1730`); both survive encodeURIComponent, so the link is
 * safe to paste into a chat window.
 */

export const SET_PARAM = 'set'

/** The set named by a URL, or null when it names none. */
export function readSet(search: string): string | null {
  // `new URLSearchParams` handles both "?a=b" and "a=b", and decodes for us.
  const value = new URLSearchParams(search).get(SET_PARAM)
  // An empty parameter (`?set=`) means the same as no parameter. Returning ''
  // would select a set whose run is the empty string and show an empty grid.
  return value === null || value === '' ? null : value
}

/** The search string a given set should have, '' when there is no set. */
export function writeSet(search: string, set: string | null): string {
  const params = new URLSearchParams(search)
  if (set === null || set === '') params.delete(SET_PARAM)
  else params.set(SET_PARAM, set)
  const next = params.toString()
  return next === '' ? '' : `?${next}`
}

/** A full shareable link for a set, given where the app is being served from. */
export function setLink(origin: string, pathname: string, set: string): string {
  return `${origin}${pathname}${writeSet('', set)}`
}
