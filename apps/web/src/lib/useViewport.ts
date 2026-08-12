import { useEffect, useState } from 'react'

/**
 * Tailwind's `md` breakpoint, as a number the tile maths can read.
 *
 * The layout decisions live in CSS (`max-md:` / `md:` classes), but the grid's
 * tile size is arithmetic — it has to *compute* how many columns fit — so this
 * one value exists in both worlds. Change it together with the classes or the
 * drawer and the tile clamp will disagree about what a phone is.
 */
export const MD_BREAKPOINT = 768

/**
 * The viewport width, updated on resize.
 *
 * Coarse on purpose: it re-renders on every resize event, which on a desktop
 * is a live drag. That is fine for the two callers this exists for — the tile
 * clamp and the drawer — because the layout is already reflowing under a
 * resize; a component that wants to avoid re-rendering during one should not
 * subscribe to this.
 *
 * The SSR-ish fallback (jsdom reports 1024) keeps tests deterministic.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => globalThis.innerWidth || 1024)
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}
