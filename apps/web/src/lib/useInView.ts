import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Viewport visibility, backed by **one** IntersectionObserver shared by every
 * tile that asks for the same margin.
 *
 * The obvious implementation gives each tile its own observer. That works, and
 * it is what most libraries do, but 10,000 observers each with one target is
 * meaningfully more expensive for the browser to maintain than one observer
 * with 10,000 targets — the callback batching, the intersection computation and
 * the bookkeeping are all per-observer.
 *
 * This is the mechanism that lets the grid render an entire directory without
 * virtualization: an offscreen tile is a sized, empty `<div>` with no `<img>`
 * inside it, so the DOM stays small where it is expensive (decoded bitmaps) and
 * large only where it is cheap (empty divs).
 */

type Callback = (inView: boolean) => void

interface SharedObserver {
  observer: IntersectionObserver
  callbacks: Map<Element, Callback>
}

const registry = new Map<string, SharedObserver>()

/**
 * Drop every cached observer.
 *
 * Test-only. The cache is keyed by `rootMargin`, not by the global
 * `IntersectionObserver` constructor, so a suite that swaps the global between
 * cases would keep getting observers built from the *first* stub. In the app
 * the constructor never changes, which is exactly why caching is safe there.
 */
export function resetInViewRegistry(): void {
  for (const shared of registry.values()) {
    shared.observer.disconnect()
    shared.callbacks.clear()
  }
  registry.clear()
}

function observerFor(rootMargin: string): SharedObserver {
  const existing = registry.get(rootMargin)
  if (existing) return existing

  const callbacks = new Map<Element, Callback>()
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        callbacks.get(entry.target)?.(entry.isIntersecting)
      }
    },
    { rootMargin, threshold: 0 },
  )

  const shared: SharedObserver = { observer, callbacks }
  registry.set(rootMargin, shared)
  return shared
}

/**
 * `rootMargin` defaults to a generous vertical band so images start loading
 * roughly one screen before they are needed. Without it, a fast scroll shows a
 * wall of empty placeholders — the images only begin fetching at the exact
 * moment they cross the viewport edge, which is far too late.
 */
export function useInView(rootMargin = '900px 0px'): {
  ref: (element: HTMLElement | null) => void
  inView: boolean
} {
  const [inView, setInView] = useState(false)
  const elementRef = useRef<HTMLElement | null>(null)

  const ref = useCallback(
    (element: HTMLElement | null) => {
      const previous = elementRef.current
      if (previous === element) return

      // `useInView` may run before the environment supports observers (jsdom in
      // a unit test). Falling back to "always visible" keeps tests rendering
      // real images instead of empty boxes.
      if (typeof IntersectionObserver === 'undefined') {
        setInView(true)
        elementRef.current = element
        return
      }

      const shared = observerFor(rootMargin)

      if (previous) {
        shared.observer.unobserve(previous)
        shared.callbacks.delete(previous)
      }

      elementRef.current = element

      if (element) {
        shared.callbacks.set(element, setInView)
        shared.observer.observe(element)
      }
    },
    [rootMargin],
  )

  useEffect(() => {
    return () => {
      const element = elementRef.current
      if (!element || typeof IntersectionObserver === 'undefined') return
      const shared = registry.get(rootMargin)
      if (!shared) return
      shared.observer.unobserve(element)
      shared.callbacks.delete(element)
      // The observer itself is kept alive: a grid re-render would otherwise
      // tear down and rebuild it on every filter change.
    }
  }, [rootMargin])

  return { ref, inView }
}
