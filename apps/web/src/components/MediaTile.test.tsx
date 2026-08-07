import type { MediaItem } from '@luma/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetInViewRegistry } from '#/lib/useInView.ts'
import { DEFAULT_TILE_SIZE, MediaTile } from './MediaTile.tsx'

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
  stars: null,
  generation: null,
  dupeGroup: null,
  upscaledFrom: null,
  upscaledTo: null,
  deviantArt: null,
  ratingOverride: null,
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
      render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />)

      const tile = screen.getByTitle('holiday.jpg')
      // 512x384 fitted into a 260px box.
      expect(tile.style.width).toBe(`${DEFAULT_TILE_SIZE}px`)
      expect(tile.style.height).toBe('195px')
      expect(document.querySelector('img')).toBeNull()
    })
  })

  describe('when onscreen', () => {
    beforeEach(() => mockObserver(true))

    it('renders the thumbnail through the luma protocol, not the original', () => {
      render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />)

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

          size={DEFAULT_TILE_SIZE}
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

          size={DEFAULT_TILE_SIZE}
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

          size={DEFAULT_TILE_SIZE}
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

          size={DEFAULT_TILE_SIZE}
        />,
      )

      expect(document.querySelector('img')?.getAttribute('src')).toBe(
        `luma://localhost/?path=${encodeURIComponent('/media/loop.gif')}`,
      )
    })

    it('is sized from the size it is given, not a constant', () => {
      // The property the grid rests on is that a tile knows its size before
      // anything loads — which has to keep holding when that size is a setting
      // rather than a compile-time number.
      render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} size={140} />)

      const tile = screen.getByTitle('holiday.jpg')
      // 512x384 fitted into 140.
      expect(tile.style.width).toBe('140px')
      expect(tile.style.height).toBe('105px')
    })

    it('badges a 4K source, and says so from the source size', () => {
      // 4000x3000. The thumbnail beside it is 512px, so reading the badge off
      // the thumbnail would mean no tile in the library ever earns one.
      render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />)
      expect(screen.getByText('4K')).toBeTruthy()
    })

    it("badges an img2img generation, off the block's own claim", () => {
      render(
        <MediaTile
          item={{
            ...item,
            generation: { tool: 'Stable Diffusion', needsSourceImage: true, postprocessed: false, characters: [] },
          }}
          onOpen={() => {}}
          showBoxes={false}
          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.getByTitle(/Made from another image/)).toBeTruthy()
    })

    it('badges an Extras-tab upscale with e', () => {
      render(
        <MediaTile
          item={{
            ...item,
            generation: { tool: 'Stable Diffusion', needsSourceImage: false, postprocessed: true, characters: [] },
          }}
          onOpen={() => {}}
          showBoxes={false}
          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.getByTitle(/Upscaled in the Extras tab/)).toBeTruthy()
    })

    it('badges a posted picture with d, and says when', () => {
      render(
        <MediaTile
          item={{
            ...item,
            deviantArt: { url: 'https://d/1', published: true, postedAt: 1754400000000 },
          }}
          onOpen={() => {}}
          showBoxes={false}
          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.getByText('d')).toBeTruthy()
      expect(screen.getByTitle(/Posted to DeviantArt on/)).toBeTruthy()
    })

    it('distinguishes staged-but-not-posted from posted', () => {
      // Two genuinely different states. Staged means there is something waiting
      // in Studio to go finish — a badge that read the same for both would say
      // "done" about work that is not.
      render(
        <MediaTile
          item={{ ...item, deviantArt: { url: null, published: false, postedAt: 1754400000000 } }}
          onOpen={() => {}}
          showBoxes={false}
          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.getByTitle(/waiting in your Studio/)).toBeTruthy()
    })

    it('leaves an unposted picture without the d badge', () => {
      render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />)
      expect(screen.queryByText('d')).toBeNull()
    })

    it('leaves a txt2img generation without the i2i badge', () => {
      render(
        <MediaTile
          item={{
            ...item,
            generation: { tool: 'Stable Diffusion', needsSourceImage: false, postprocessed: false, characters: [] },
          }}
          onOpen={() => {}}
          showBoxes={false}
          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.queryByTitle(/Made from another image/)).toBeNull()
    })

    it('leaves a smaller picture unbadged', () => {
      render(
        <MediaTile
          item={{ ...item, width: 1920, height: 1080 }}
          onOpen={() => {}}
          showBoxes={false}
          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.queryByText('4K')).toBeNull()
    })

    it('badges a portrait shot of the same size', () => {
      render(
        <MediaTile
          item={{ ...item, width: 2160, height: 3840 }}
          onOpen={() => {}}
          showBoxes={false}
          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.getByText('4K')).toBeTruthy()
    })

    it('shows a duration badge for videos', () => {
      render(
        <MediaTile
          item={{ ...item, kind: 'video', durationSec: 247 }}
          onOpen={() => {}}
          showBoxes={false}

          size={DEFAULT_TILE_SIZE}
        />,
      )
      expect(screen.getByText('4:07')).toBeTruthy()
    })
  })
})

describe('the folder-path overlay', () => {
  beforeEach(() => mockObserver(true))

  const filed: MediaItem = {
    ...item,
    path: String.raw`\?\UNC\jebpot\devs\AI\characters\aqua-konosuba\best\00166.png`,
    name: '00166.png',
  }

  it('says why the tile is in the results, in folder mode only', () => {
    // The picture and the filename look identical whether the folder matched
    // or not, so without this a folder search is a grid of unexplained hits.
    const { unmount } = render(
      <MediaTile
        item={filed}
        onOpen={() => {}}
        showBoxes={false}
        size={DEFAULT_TILE_SIZE}
        folderTerm="aqua"
      />,
    )
    // `textContent`, not `getByText`: the matched run is wrapped in its own
    // element so the label is deliberately split across three nodes.
    expect(document.body.textContent).toContain('aqua-konosuba')
    unmount()

    // Not in the ordinary mode: there the filename on the tile is already the
    // reason, and a second label would only repeat it.
    render(<MediaTile item={filed} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />)
    expect(document.body.textContent).not.toContain('aqua-konosuba')
  })

  it('shows the readable path, never the extended-length form', () => {
    render(
      <MediaTile
        item={filed}
        onOpen={() => {}}
        showBoxes={false}
        size={DEFAULT_TILE_SIZE}
        folderTerm="jebpot"
      />,
    )
    // The extended-length prefix spends the few characters there is room for
    // on nothing anybody can read.
    expect(document.body.textContent).not.toContain(String.raw`\\?\UNC`)
    expect(document.body.textContent).toContain('jebpot')
  })

  it('stays silent on a row whose own path does not carry the term', () => {
    // A variant stands in for an original filed elsewhere, so this is normal.
    render(
      <MediaTile
        item={filed}
        onOpen={() => {}}
        showBoxes={false}
        size={DEFAULT_TILE_SIZE}
        folderTerm="moona"
      />,
    )
    expect(document.body.textContent).not.toContain('konosuba')
  })
})

describe('the star score on a tile', () => {
  beforeEach(() => mockObserver(true))

  it('draws one glyph per star and nothing else', () => {
    render(
      <MediaTile item={{ ...item, stars: 4 }} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />,
    )
    // Filled only. Five glyphs with the empty ones drawn would put a widget on
    // every tile in the grid, where what is wanted is a glance.
    expect(screen.getByTitle('4 of 5 stars').textContent).toBe('★★★★')
  })

  it('says nothing at all when the item is unrated', () => {
    render(<MediaTile item={item} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />)
    expect(document.body.textContent).not.toContain('★')
  })

  it('shows nothing offscreen, where the tile mounts no content', () => {
    cleanup()
    resetInViewRegistry()
    mockObserver(false)
    render(
      <MediaTile item={{ ...item, stars: 5 }} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />,
    )
    expect(document.body.textContent).not.toContain('★')
  })

  // `stars` is a nullable number on the wire; `'★'.repeat(n)` throws on a
  // negative and would hang the tile on a large one.
  it('clamps a value outside 1-5 rather than trusting it', () => {
    render(
      <MediaTile item={{ ...item, stars: 99 }} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />,
    )
    expect(screen.getByTitle('5 of 5 stars').textContent).toBe('★★★★★')

    cleanup()
    resetInViewRegistry()
    render(
      <MediaTile item={{ ...item, stars: -3 }} onOpen={() => {}} showBoxes={false} size={DEFAULT_TILE_SIZE} />,
    )
    expect(document.body.textContent).not.toContain('★')
  })

  it('clears the selection tick, which shares the corner', () => {
    render(
      <MediaTile
        item={{ ...item, stars: 3 }}
        onOpen={() => {}}
        showBoxes={false}
        size={DEFAULT_TILE_SIZE}
        selected
      />,
    )
    expect(screen.getByTitle('3 of 5 stars').className).toContain('ml-5')
  })
})
