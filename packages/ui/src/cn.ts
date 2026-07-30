/**
 * Join class names, dropping falsy entries.
 *
 * Deliberately not `tailwind-merge`: this kit's components take a `className`
 * that is appended last, and Tailwind's own later-wins cascade handles the
 * override. Pulling in a 30kB conflict resolver to solve a problem the utility
 * order already solves is not a trade worth making here.
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
