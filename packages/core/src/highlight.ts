/**
 * Showing *why* a search result matched.
 *
 * A prompt in this library routinely runs to 200 tags. Rendering it whole under
 * a search hit buries the match, and truncating from the front usually cuts it
 * off entirely — the reason a row is in the list is often 300 characters in.
 * So the excerpt is taken around the match, not from the beginning.
 */

export interface HighlightPart {
  text: string
  match: boolean
}

/**
 * Split `text` into alternating plain and matching parts.
 *
 * Case-insensitive and literal: the terms come from a search box, so `(wide`
 * must be searched for rather than compiled as an unterminated group.
 */
export function highlight(text: string, terms: string[]): HighlightPart[] {
  const wanted = terms
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length)
  if (wanted.length === 0 || !text) return [{ text, match: false }]

  const parts: HighlightPart[] = []
  const lower = text.toLowerCase()
  let at = 0
  while (at < text.length) {
    // The earliest match of any term, longest first so overlapping terms do not
    // produce a highlight inside a highlight.
    let bestAt = -1
    let bestLength = 0
    for (const term of wanted) {
      const found = lower.indexOf(term, at)
      if (found >= 0 && (bestAt < 0 || found < bestAt)) {
        bestAt = found
        bestLength = term.length
      }
    }
    if (bestAt < 0) {
      parts.push({ text: text.slice(at), match: false })
      break
    }
    if (bestAt > at) parts.push({ text: text.slice(at, bestAt), match: false })
    parts.push({ text: text.slice(bestAt, bestAt + bestLength), match: true })
    at = bestAt + bestLength
  }
  return parts.filter((part) => part.text.length > 0)
}

/**
 * A window of `text` centred on the first match, with ellipses where it was cut.
 *
 * Returns the head of the text when nothing matches, which is what a result
 * matched on its filename should show.
 */
export function excerpt(text: string, terms: string[], radius = 60): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  const lower = trimmed.toLowerCase()
  let at = -1
  for (const term of terms) {
    const needle = term.trim().toLowerCase()
    if (!needle) continue
    const found = lower.indexOf(needle)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return trimmed.length > radius * 2 ? trimmed.slice(0, radius * 2) + '…' : trimmed

  const from = Math.max(0, at - radius)
  const to = Math.min(trimmed.length, at + radius)
  return (from > 0 ? '…' : '') + trimmed.slice(from, to) + (to < trimmed.length ? '…' : '')
}

/** The words a search box's contents should be matched on. */
export function searchTerms(query: string): string[] {
  return query.split(/\s+/).filter((term) => term.length > 0)
}
