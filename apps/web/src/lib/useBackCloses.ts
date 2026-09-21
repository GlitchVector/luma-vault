import { useEffect, useRef } from 'react'

/**
 * A full-screen panel as a history entry, so the phone's back gesture and the browser's back button
 * close it instead of leaving the app — or, on the LAN tab, doing nothing and leaving the person
 * "trapped forever inside the page" (owner, 2026-09-21, on the LoRAs panel).
 *
 * Same shape as the lightbox in `App.tsx`: one entry per *opening*, taken back out when the panel
 * closes from inside (a button, Escape) so the next back gesture does not spend a press undoing a
 * navigation that already looks undone, and a hash left over from a reload is stripped on mount.
 */
export function useBackCloses(open: boolean, close: () => void, hash: string) {
  const inHistory = useRef(false)
  // Read through a ref so an inline `() => setOpen(false)` does not re-subscribe on every render.
  const closeRef = useRef(close)
  closeRef.current = close
  const anchor = `#${hash}`

  useEffect(() => {
    if (open && !inHistory.current) {
      inHistory.current = true
      globalThis.history?.pushState({ panel: hash }, '', anchor)
    }
    if (!open && inHistory.current) {
      inHistory.current = false
      if (globalThis.location?.hash === anchor) globalThis.history?.back()
    }
  }, [open, hash, anchor])

  useEffect(() => {
    // The gesture itself: the browser has already popped the entry, only the state has to follow.
    const onPop = () => {
      if (!inHistory.current) return
      inHistory.current = false
      closeRef.current()
    }
    window.addEventListener('popstate', onPop)
    if (globalThis.location?.hash === anchor) {
      globalThis.history?.replaceState(null, '', globalThis.location.pathname + globalThis.location.search)
    }
    return () => window.removeEventListener('popstate', onPop)
  }, [anchor])
}
