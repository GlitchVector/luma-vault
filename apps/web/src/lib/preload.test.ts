import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pendingPreloads, preloadImages, resetPreloads } from './preload.ts'

/**
 * The warming is invisible when it breaks — the picture still arrives, just at
 * the moment it is needed rather than before. So what is pinned here is the
 * thing that would silently turn it back into ordinary loading: asking for the
 * same URL over and over.
 */

const requested: string[] = []
const handlers: Array<Record<string, () => void>> = []

class FakeImage {
  #src = ''
  #own: Record<string, () => void> = {}

  constructor() {
    handlers.push(this.#own)
  }

  addEventListener(type: string, listener: () => void) {
    this.#own[type] = listener
  }

  set src(value: string) {
    this.#src = value
    requested.push(value)
  }

  get src() {
    return this.#src
  }
}

beforeEach(() => {
  requested.length = 0
  handlers.length = 0
  resetPreloads()
  vi.stubGlobal('Image', FakeImage)
})

afterEach(() => {
  resetPreloads()
  vi.unstubAllGlobals()
})

describe('preloadImages', () => {
  it('requests each URL exactly once, however often it is asked', () => {
    // A scan pushes progress four times a second and every one re-renders the
    // app. Without this the warming becomes the load it exists to avoid.
    preloadImages(['a.jpg', 'b.jpg'])
    preloadImages(['a.jpg', 'b.jpg'])
    preloadImages(['b.jpg', 'a.jpg'])

    expect(requested).toEqual(['a.jpg', 'b.jpg'])
  })

  it('holds a reference until the request settles', () => {
    // A bare `new Image()` with nowhere to live is collectable mid-fetch, and a
    // collected image's request is cancelled — so the naive version of this
    // works right until the garbage collector runs, which is when the machine
    // is busy and the warming mattered.
    preloadImages(['a.jpg'])
    expect(pendingPreloads()).toBe(1)

    handlers[0]?.load?.()
    expect(pendingPreloads()).toBe(0)
  })

  it('lets a URL be asked for again once its request has finished', () => {
    preloadImages(['a.jpg'])
    handlers[0]?.load?.()

    // Served from the browser's own cache this time, which is the whole reason
    // there is no cache here.
    preloadImages(['a.jpg'])
    expect(requested).toEqual(['a.jpg', 'a.jpg'])
  })

  it('drops a failed request rather than holding it forever', () => {
    preloadImages(['gone.jpg'])
    handlers[0]?.error?.()
    expect(pendingPreloads()).toBe(0)
  })

  it('ignores empty paths and does nothing where there is no Image', () => {
    preloadImages(['', 'a.jpg'])
    expect(requested).toEqual(['a.jpg'])

    vi.stubGlobal('Image', undefined)
    expect(() => preloadImages(['b.jpg'])).not.toThrow()
  })
})
