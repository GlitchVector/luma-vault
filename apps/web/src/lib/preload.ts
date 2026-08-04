/**
 * Fetching a picture before anything asks to display it.
 *
 * Stepping through the lightbox is the case this exists for. The poster the
 * next row will be drawn from is a file like any other: the first time it is
 * put in front of the user, the webview has to go and get it, and that shows as
 * a beat of empty frame on every single step. Asking for it while the previous
 * picture is still on screen moves that fetch into time nobody is waiting.
 *
 * There is no cache here and deliberately so — the browser already has one, and
 * `fileUrl` hands out ordinary URLs precisely so that decoding, caching and
 * eviction stay the browser's problem. All this does is make the request early.
 * A second request for the same URL is served from that cache and costs a
 * round-trip to memory.
 */

/**
 * Requests still in the air, held only so they finish.
 *
 * A bare `new Image()` with nowhere to live is collectable the moment the
 * statement ends, and a collected image's fetch is cancelled — so the naive
 * one-liner version of this function works right up until the garbage collector
 * runs, which is exactly when the machine is busy and the warming mattered.
 */
const inFlight = new Map<string, HTMLImageElement>()

/**
 * Start fetching `urls`, and return without waiting for any of them.
 *
 * Best-effort by design: a URL that 404s or decodes to nothing is dropped
 * silently, because nothing here is displaying it. Whatever eventually renders
 * the picture reports its own failure, in the place where a person can see it.
 */
export function preloadImages(urls: readonly string[]): void {
  if (typeof Image === 'undefined') return

  for (const url of urls) {
    if (!url || inFlight.has(url)) continue

    const image = new Image()
    inFlight.set(url, image)

    const settled = () => {
      inFlight.delete(url)
    }
    image.addEventListener('load', settled, { once: true })
    image.addEventListener('error', settled, { once: true })

    // Assigned last: a cached image can fire `load` synchronously on assignment
    // in some engines, and a handler attached afterwards would never see it and
    // would leak the entry.
    image.src = url
  }
}

/** Test seam. Drops the in-flight table without cancelling anything. */
export function resetPreloads(): void {
  inFlight.clear()
}

/** Test seam. How many requests are still outstanding. */
export function pendingPreloads(): number {
  return inFlight.size
}
