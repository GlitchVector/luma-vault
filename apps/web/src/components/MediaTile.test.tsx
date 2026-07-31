import type { MediaItem } from '@luma/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInViewRegistry } from '#/lib/useInView.ts'
import { MediaTile, TILE_SIZE } from './MediaTile.tsx'

/**
 * These tests pin the two properties the grid's performance rests on, both of
 * which are easy to break with an innocent-looking refactor:
 *
 * 1. A tile occupies its final size **before** any image loads.
 * 2. An offscreen tile mounts no `<img>` at all.
 */

const observed = new Map<Element, (entries: IntersectionObserverEntry[]) => void>()

function mockObserver(intersecting: boolean) {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private callback: (entries: IntersectionObserverEntry[]) => void) {}
      observe(target: Element) {
        observed.set(target, this.callback)
        this.callback([{ target, isIntersecting: intersecting } as IntersectionObserverEntry])
      }
      unobserve(target: Element) {
        observed.delete(target)
      }
      disconnect() {
        observed.clear()
      }
    },
  )
}

const item: MediaItem = {
  id: 1,
  folderId: 1,
  path: '/media/holiday.jpg',
  name: 'holiday.jpg',
  kind: 'image',
  width: 4000,
  height: 3000,
  sizeBytes: 2_400_000,
  modifiedAt: 1_700_000_000_000,
  addedAt: 1_700_000_000_000,
  thumbPath: '/thumbs/ab/cd/holiday.jpg',
  thumbWidth: 512,
  thumbHeight: 384,
  durationSec: null,
  verdict: null,
  classifiedAt: null,
}

afterEach(() => {
  cleanup()
  observed.clear()
  // The hook caches one observer per rootMargin for the lifetime of the module;
  // without this reset every case after the first would reuse the first stub.
  resetInViewRegistry()
  vi.unstubAllGlobals()
})

describe('MediaTile', () => {
  describe('when offscreen', () => {
    beforeEach(() => mockObserver(false))

    it('reserves its exact final size with no image mounted', () => {
      render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} />)

      const tile = screen.getByTitle('holiday.jpg')
      // 512x384 fitted into a 260px box.
      expect(tile.style.width).toBe(`${TILE_SIZE}px`)
      expect(tile.style.height).toBe('195px')
      expect(document.querySelector('img')).toBeNull()
    })
  })

  describe('when onscreen', () => {
    beforeEach(() => mockObserver(true))

    it('renders the thumbnail through the luma protocol, not the original', () => {
      render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} />)

      const image = document.querySelector('img')
      expect(image?.getAttribute('src')).toBe(
        `luma://localhost/?path=${encodeURIComponent('/thumbs/ab/cd/holiday.jpg')}`,
      )
      expect(image?.getAttribute('decoding')).toBe('async')
    })

    it('renders an animated GIF from the original so the animation survives', () => {
      render(
        <MediaTile
          item={{ ...item, path: '/media/loop.gif', name: 'loop.gif' }}
          onOpen={() => {}}
          showBoxes={false}
        />,
      )

      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        `luma://localhost/?path=${encodeURIComponent('/media/loop.gif')}`,
      )
    })

    it('falls back to source dimensions when no thumbnail exists yet', () => {
      render(
        <MediaTile
          item={{ ...item, thumbPath: null, thumbWidth: null, thumbHeight: null }}
          onOpen={() => {}}
          showBoxes={false}
        />,
      )

      const tile = screen.getByTitle('holiday.jpg')
      // 4000x3000 fitted into 260 — a mid-scan tile is still correctly shaped.
      expect(tile.style.width).toBe('260px')
      expect(tile.style.height).toBe('195px')
    })

    it('mounts no image at all until a thumbnail exists, never the original', () => {
      // Rendering the multi-megapixel source as a stand-in is what killed the
      // webview: mid-scan that is most of the library, and a screenful of
      // decoded originals exhausts the renderer. An unthumbnailed tile is a
      // sized placeholder, exactly like an offscreen one.
      render(
        <MediaTile
          item={{ ...item, thumbPath: null, thumbWidth: null, thumbHeight: null }}
          onOpen={() => {}}
          showBoxes={false}
        />,
      )

      expect(document.querySelector('img')).toBeNull()
    })

    it('still renders an animated original, which is the one deliberate exception', () => {
      render(
        <MediaTile
          item={{ ...item, path: '/media/loop.gif', name: 'loop.gif', thumbPath: null }}
          onOpen={() => {}}
          showBoxes={false}
        />,
      )

      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        `luma://localhost/?path=${encodeURIComponent('/media/loop.gif')}`,
      )
    })

    it('shows a duration badge for videos', () => {
      render(
        <MediaTile
          item={{ ...item, kind: 'video', durationSec: 247 }}
          onOpen={() => {}}
          showBoxes={false}
        />,
      )
      expect(screen.getByText('4:07')).toBeTruthy()
    })
  })
})
