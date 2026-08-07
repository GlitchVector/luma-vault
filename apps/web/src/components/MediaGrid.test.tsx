import type { MediaItem } from '@luma/core'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInViewRegistry } from '#/lib/useInView.ts'
import { MediaGrid } from './MediaGrid.tsx'

/**
 * How the grid asks for the next page.
 *
 * The mechanism is easy to get subtly wrong in a way nothing notices: an
 * IntersectionObserver reports *changes*, so a sentinel that is already in view
 * and stays in view never fires again. With a deep lookahead that is the normal
 * case rather than the corner one — a page frequently fails to push the
 * sentinel back out of the band — and paging silently stalls until the next
 * scroll. These pin the re-ask that stops it.
 */

/** The sentinel's observer, with its callback exposed so a test can move it. */
let sentinelObserver: { callback: (entries: unknown[]) => void; targets: Element[] } | null = null

beforeEach(() => {
  sentinelObserver = null
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      targets: Element[] = []
      constructor(private callback: (entries: unknown[]) => void) {}
      observe(target: Element) {
        this.targets.push(target)
        // The tiles use `useInView` with their own margin; the grid's sentinel
        // is the one observed with no root and a percentage margin. Only the
        // last observer created per render matters here, and the grid's is
        // created after the tiles have mounted.
        sentinelObserver = { callback: this.callback, targets: this.targets }
      }
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  resetInViewRegistry()
  vi.unstubAllGlobals()
})

function makeItem(id: number): MediaItem {
  return {
    id,
    folderId: 1,
    path: `/media/image-${id}.png`,
    name: `image-${id}.png`,
    kind: 'image',
    width: 1024,
    height: 1024,
    sizeBytes: 500_000,
    modifiedAt: 1_700_000_000_000,
    addedAt: 1_700_000_000_000 + id,
    thumbPath: `/thumbs/image-${id}.png`,
    thumbWidth: 512,
    thumbHeight: 512,
    durationSec: null,
    verdict: null,
    classifiedAt: null,
    stars: null,
    generation: null,
    dupeGroup: null,
    upscaledFrom: null,
    upscaledTo: null,
    deviantArt: null,
  }
}

const page = (count: number, from = 1) =>
  Array.from({ length: count }, (_, index) => makeItem(from + index))

function renderGrid(items: MediaItem[], onReachEnd: () => void) {
  return render(
    <MediaGrid
      items={items}
      onOpen={() => {}}
      onReachEnd={onReachEnd}
      showBoxes={false}
      groupDuplicates={false}
      tileSize={200}
      selected={new Set()}
    />,
  )
}

/** Move the sentinel into or out of the lookahead band. */
function setNearEnd(intersecting: boolean) {
  act(() => {
    sentinelObserver?.callback([{ isIntersecting: intersecting }])
  })
}

describe('asking for the next page', () => {
  it('does not ask while the end is nowhere near', () => {
    const asks = vi.fn()
    renderGrid(page(20), asks)
    setNearEnd(false)
    expect(asks).not.toHaveBeenCalled()
  })

  it('asks as soon as the end comes within the lookahead band', () => {
    const asks = vi.fn()
    renderGrid(page(20), asks)
    setNearEnd(true)
    expect(asks).toHaveBeenCalledTimes(1)
  })

  it('asks again when the page that arrived did not clear the band', () => {
    // The stall this exists to prevent. The sentinel never left the band, so
    // the observer has nothing to report — without the re-ask, paging stops
    // here and the grid sits at one page until the user scrolls.
    const asks = vi.fn()
    const { rerender } = renderGrid(page(20), asks)
    setNearEnd(true)
    expect(asks).toHaveBeenCalledTimes(1)

    rerender(
      <MediaGrid
        items={page(40)}
        onOpen={() => {}}
        onReachEnd={asks}
        showBoxes={false}
        groupDuplicates={false}
        tileSize={200}
        selected={new Set()}
      />,
    )

    expect(asks).toHaveBeenCalledTimes(2)
  })

  it('stops asking once the band is clear', () => {
    // The chain has to end on its own. A page that pushes the sentinel out
    // must not keep pulling more behind it.
    const asks = vi.fn()
    const { rerender } = renderGrid(page(20), asks)
    setNearEnd(true)
    expect(asks).toHaveBeenCalledTimes(1)

    setNearEnd(false)
    rerender(
      <MediaGrid
        items={page(40)}
        onOpen={() => {}}
        onReachEnd={asks}
        showBoxes={false}
        groupDuplicates={false}
        tileSize={200}
        selected={new Set()}
      />,
    )

    expect(asks).toHaveBeenCalledTimes(1)
  })
})
