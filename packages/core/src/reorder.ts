/**
 * Moving rows inside an ordered list by hand — the Patreon post's picture order.
 *
 * Pure, over indices, because the UI only knows "these rows were dragged and
 * dropped before that one"; what the new list is should not depend on React
 * state or on how the drop target was hit. Two facts make this less trivial
 * than a splice:
 *
 *   - a drop target is a *gap*, numbered 0…length, and it is measured on the
 *     list as it stands with the moving rows still in it, so it has to be
 *     corrected by however many moving rows sat above it;
 *   - several rows can move at once and must arrive as one block in their own
 *     relative order, wherever they were picked from.
 */

/**
 * The list with the rows at `moving` taken out and put back, in their current
 * relative order, so the block sits where gap `target` was.
 *
 * `target` is a gap index on the *unchanged* list: 0 is before the first row,
 * `list.length` after the last. Indices out of range and duplicates in
 * `moving` are ignored. A drop onto a gap that lies inside or right beside the
 * block — or with nothing to move — returns the list untouched, so the caller
 * can compare by identity and skip a pointless write.
 */
export function moveRows<T>(list: readonly T[], moving: Iterable<number>, target: number): readonly T[] {
  const picked = [...new Set(moving)].filter((i) => Number.isInteger(i) && i >= 0 && i < list.length).sort((a, b) => a - b)
  if (picked.length === 0) return list
  const gap = Math.max(0, Math.min(list.length, target))
  const above = picked.filter((i) => i < gap).length
  const insertAt = gap - above
  const rest = list.filter((_, i) => !picked.includes(i))
  const next = [...rest.slice(0, insertAt), ...picked.map((i) => list[i] as T), ...rest.slice(insertAt)]
  return next.every((row, i) => row === list[i]) ? list : next
}

/** The list back to front — the whole post the other way round, first picture last. */
export function reverseRows<T>(list: readonly T[]): readonly T[] {
  return list.length < 2 ? list : [...list].reverse()
}
