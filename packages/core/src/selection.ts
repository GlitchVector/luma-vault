/**
 * Picking a set of rows out of the grid.
 *
 * Pure, and about *ids in a given order* rather than about React state, because
 * the only interesting question here is what a shift-click means — and that
 * question is answered entirely by the order the grid is currently in.
 */

/**
 * Every id from `anchor` to `target` inclusive, in the list's own order.
 *
 * The order is the *filtered* one the grid is showing, not the library's. That
 * is the whole point: shift-clicking after narrowing to 4K videos should select
 * the run you can see, not everything that happens to sit between them in the
 * index. So this takes the list rather than consulting anything global.
 *
 * Direction-agnostic — shift-clicking upwards is as ordinary as downwards, and
 * a person doing it does not think of themselves as selecting backwards.
 *
 * An id that is not in `ids` yields nothing: the anchor can go stale when a
 * filter changes under a held selection, and a stale anchor should select
 * nothing rather than a range measured from a guess.
 */
export function rangeBetween(
  ids: readonly number[],
  anchor: number,
  target: number,
): number[] {
  const from = ids.indexOf(anchor)
  const to = ids.indexOf(target)
  if (from < 0 || to < 0) return []
  return from <= to ? ids.slice(from, to + 1) : ids.slice(to, from + 1)
}

/**
 * Add or remove one id, returning a new set.
 *
 * A new set rather than a mutation because React compares by identity: mutating
 * in place gives a grid that is correct in memory and never re-renders.
 */
export function toggleSelected(
  selected: ReadonlySet<number>,
  id: number,
): Set<number> {
  const next = new Set(selected)
  if (!next.delete(id)) next.add(id)
  return next
}

/**
 * Drop anything no longer in `ids`.
 *
 * A selection outlives the filter it was made under — narrow to favourites,
 * select ten, widen again — and rows that scrolled out of the query would
 * otherwise stay silently selected, so an action would run over pictures that
 * have not been on screen for some time.
 */
export function retainVisible(
  selected: ReadonlySet<number>,
  ids: readonly number[],
): Set<number> {
  const visible = new Set(ids)
  return new Set([...selected].filter((id) => visible.has(id)))
}
