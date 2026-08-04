import type { MediaItem } from '@luma/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogs } from '#/lib/dialogs.ts'
import { resetInViewRegistry } from '#/lib/useInView.ts'
import { App } from './App.tsx'

/**
 * Deleting a file, end to end, against a fake backend.
 *
 * This exists because the delete button has now failed three times in three
 * different places — a confirm that returned `undefined`, a shell call that
 * could not address a UNC path, and a stale strip — and each one looked exactly
 * like the others from the outside. None of them was reachable by a unit test
 * of the piece that was actually wrong.
 *
 * The library here is deliberately **larger than one page**. That is the whole
 * point of the case: with a short list, deleting a row shortens the grid and
 * any signal derived from its length changes by accident. With a full page, the
 * grid refills from the next page, the length is identical before and after,
 * and anything watching a length concludes nothing happened.
 */

const PAGE = 300
const LIBRARY_SIZE = 320

function makeItem(id: number): MediaItem {
  return {
    id,
    folderId: 1,
    path: `\\\\?\\UNC\\jebpot\\devs\\AI\\image-${id}.png`,
    name: `image-${id}.png`,
    kind: 'image',
    width: 1024,
    height: 1024,
    sizeBytes: 500_000,
    modifiedAt: 1_700_000_000_000,
    addedAt: 1_700_000_000_000 + id,
    thumbPath: `/thumbs/ab/cd/image-${id}.png`,
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
  }
}

/** Newest first, which is what both the strip and the grid ask for. */
let library: MediaItem[] = []
const deleteCalls: Array<{ id: number; permanent: boolean }> = []
const starCalls: Array<{ id: number; stars: number | null }> = []
/** Every query the grid asked the backend for, so a filter can be checked end to end. */
const queries: Array<{ minStars?: number | null; minLongestEdge?: number | null }> = []
/** Ids each upscale run was asked for. */
const upscaleCalls: number[][] = []
/** Each batch delete, so one call for the whole set can be asserted. */
const deleteBatches: Array<{ ids: number[]; permanent: boolean }> = []

vi.mock('#/lib/native.ts', () => ({
  isTauri: () => true,
  fileUrl: (path: string) => `luma://${path}`,
  listFolders: () =>
    Promise.resolve([
      {
        id: 1,
        path: String.raw`\\?\UNC\jebpot\devs\AI`,
        addedAt: 0,
        lastScanAt: 0,
        available: true,
        mediaCount: library.length,
      },
    ]),
  queryMedia: (query: { offset: number; limit: number; minStars?: number | null }) => {
    queries.push(query)
    const matching =
      query.minStars == null ? library : library.filter((item) => (item.stars ?? 0) >= query.minStars!)
    return Promise.resolve({
      items: matching.slice(query.offset, query.offset + query.limit),
      total: matching.length,
      offset: query.offset,
    })
  },
  recentMedia: (limit: number) => Promise.resolve(library.slice(0, limit)),
  mediaById: (id: number) => Promise.resolve(library.find((item) => item.id === id) ?? null),
  mediaFrames: () => Promise.resolve([]),
  deleteItem: (id: number, permanent: boolean) => {
    deleteCalls.push({ id, permanent })
    library = library.filter((item) => item.id !== id)
    return Promise.resolve()
  },
  libraryStats: () =>
    Promise.resolve({
      folders: 1,
      images: library.length,
      videos: 0,
      classified: library.length,
      pending: 0,
      sexy: 0,
      failed: 0,
    }),
  listExclusions: () => Promise.resolve([]),
  scanProgress: () =>
    Promise.resolve({ phase: 'idle', folderId: null, done: 0, total: 0, current: null, errors: [] }),
  environment: () =>
    Promise.resolve({
      classifierAvailable: true,
      ffmpegAvailable: true,
      busy: false,
      throttle: 'off',
    }),
  onScanProgress: () => () => {},
  processPending: () => Promise.resolve(),
  setStars: (id: number, stars: number | null) => {
    starCalls.push({ id, stars })
    return Promise.resolve()
  },
  revealInFileManager: () => Promise.resolve(),
  generationParameters: () => Promise.resolve(null),
  forgeUrl: () => Promise.resolve('http://127.0.0.1:7860'),
  openExternal: () => Promise.resolve(),
  excludeFolder: () => Promise.resolve(0),
  includeFolder: () => Promise.resolve(),
  findDuplicates: () =>
    Promise.resolve({
      groups: 0,
      files: 0,
      imageGroups: 0,
      videoGroups: 0,
      hashed: 0,
      skippedCommon: 0,
    }),
  setThrottle: () => Promise.resolve(),
  retryFailed: () => Promise.resolve(0),
  addFolder: () => Promise.resolve(null),
  removeFolder: () => Promise.resolve(),
  rescanFolder: () => Promise.resolve(),
  pickFolder: () => Promise.resolve(null),
  pickImageBrowserDb: () => Promise.resolve(null),
  importImageBrowserDb: () => Promise.resolve(null),
  setForgeUrl: () => Promise.resolve(),
  upscaleMedia: (ids: number[]) => {
    upscaleCalls.push(ids)
    return Promise.resolve({
      upscaled: ids.length,
      skipped: 0,
      alreadyLarge: 0,
      failed: 0,
      seconds: 8.4,
      peakVramMb: 2142,
      model: '4x-AnimeSharp.pth',
      architecture: 'ESRGAN',
      outputs: ids.map((id) => ({
        source: `/media/image-${id}.png`,
        destination: `/media/image-${id}_upscaled_4k.png`,
        name: `image-${id}.png`,
        sourceWidth: 896,
        sourceHeight: 1192,
        finalWidth: 2886,
        finalHeight: 3840,
        seconds: 4.2,
      })),
      errors: [],
    })
  },
  onUpscaleProgress: () => Promise.resolve(() => {}),
  deleteMedia: (ids: number[], permanent: boolean) => {
    deleteBatches.push({ ids, permanent })
    library = library.filter((item) => !ids.includes(item.id))
    return Promise.resolve({ deleted: ids.length, missing: 0, failed: 0, errors: [] })
  },
}))

beforeEach(() => {
  library = Array.from({ length: LIBRARY_SIZE }, (_, index) => makeItem(LIBRARY_SIZE - index))
  deleteCalls.length = 0
  starCalls.length = 0
  queries.length = 0
  upscaleCalls.length = 0
  deleteBatches.length = 0
  // The tile size is remembered here, so a case that sets it would otherwise
  // decide the starting size of every case after it.
  localStorage.clear()
  // Offscreen tiles mount no image, which keeps a 300-tile grid cheap here.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  resetDialogs()
  cleanup()
  resetInViewRegistry()
  vi.unstubAllGlobals()
})

describe('rating from the keyboard', () => {
  /** A digit pressed the way a keyboard rates: bare, on the document. */
  function press(key: string, init: KeyboardEventInit = {}) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  }

  it('rates with 1-5 and clears with 0', async () => {
    render(<App />)
    const item = `image-${LIBRARY_SIZE}.png`
    ;(await screen.findByTitle(item)).click()
    await screen.findByRole('group', { name: 'Rating' })

    press('4')
    await waitFor(() => expect(starCalls).toEqual([{ id: LIBRARY_SIZE, stars: 4 }]))
    // The stars redraw immediately rather than after the round-trip, because
    // this is meant to be held down through a folder.
    expect(screen.getByRole('button', { name: '4 stars' }).getAttribute('aria-pressed')).toBe('true')

    press('0')
    await waitFor(() =>
      expect(starCalls).toEqual([
        { id: LIBRARY_SIZE, stars: 4 },
        { id: LIBRARY_SIZE, stars: null },
      ]),
    )
    expect(screen.getByRole('button', { name: '4 stars' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('ignores a digit pressed with a modifier', async () => {
    // Ctrl-0 resets the browser zoom and Cmd-1 switches tabs. Stealing either
    // would be worse than not having the shortcut.
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })

    press('3', { ctrlKey: true })
    press('3', { metaKey: true })
    await waitFor(() => expect(starCalls).toEqual([]))
  })

  it('does not rate while something is being typed into', async () => {
    // The search field is a sibling of the lightbox, and a listener that eats
    // digits would make searching for "00166" rate whatever is open.
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })

    const field = document.createElement('input')
    document.body.append(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }))
    await waitFor(() => expect(starCalls).toEqual([]))
    field.remove()
  })
})

describe('the grid size slider', () => {
  const tile = () => screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

  it('resizes every tile in the grid', async () => {
    render(<App />)
    // 512x512 thumbnails fitted into the default 260.
    expect((await tile()).style.width).toBe('260px')

    fireEvent.change(screen.getByLabelText('Grid image size'), { target: { value: '140' } })

    await waitFor(async () => expect((await tile()).style.width).toBe('140px'))
  })

  it('is remembered, so the grid opens the way it was left', async () => {
    // Unlike the view toggles beside it. Those answer a question you have right
    // now; this is how you use the app, and re-setting it every launch would
    // read as the setting not sticking.
    localStorage.setItem('luma.tileSize', '320')
    render(<App />)
    expect((await tile()).style.width).toBe('320px')
  })

  it('clamps a stored size instead of trusting it', async () => {
    // It comes back as whatever is in storage — a value from an older range, or
    // something hand-edited. A wall of 4000px tiles must not be reachable that
    // way, and neither must a wall of 1px ones.
    localStorage.setItem('luma.tileSize', '4000')
    const { unmount } = render(<App />)
    expect((await tile()).style.width).toBe('480px')
    unmount()

    localStorage.setItem('luma.tileSize', 'not a number')
    render(<App />)
    expect((await tile()).style.width).toBe('260px')
  })
})

describe('selecting images', () => {
  const tile = (id: number) => screen.getByTitle(`image-${id}.png`)
  const startSelecting = async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')
  }
  /** Newest first, so id LIBRARY_SIZE is the first tile and they count down. */
  const nth = (index: number) => LIBRARY_SIZE - index

  it('does not select until the mode is on', async () => {
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    // Clicking a picture has to keep meaning "open it" the rest of the time.
    expect(await screen.findByRole('group', { name: 'Rating' })).toBeTruthy()
  })

  it('picks one at a time, and unpicks', async () => {
    await startSelecting()

    tile(nth(0)).click()
    expect(await screen.findByText('1 selected')).toBeTruthy()
    expect(tile(nth(0)).getAttribute('aria-pressed')).toBe('true')
    // And no lightbox — the click was a pick, not an open.
    expect(screen.queryByRole('group', { name: 'Rating' })).toBeNull()

    tile(nth(0)).click()
    expect(await screen.findByText('Nothing selected')).toBeTruthy()
  })

  it('shift-clicking far down takes everything in between', async () => {
    // The case this exists for: pick one, scroll, shift-click, get the run.
    await startSelecting()

    tile(nth(0)).click()
    await screen.findByText('1 selected')
    fireEvent.click(tile(nth(9)), { shiftKey: true })

    expect(await screen.findByText('10 selected')).toBeTruthy()
    // Every tile across the span, not just the two ends.
    for (const index of [0, 1, 5, 8, 9]) {
      expect(tile(nth(index)).getAttribute('aria-pressed')).toBe('true')
    }
    expect(tile(nth(10)).getAttribute('aria-pressed')).toBeNull()
  })

  it('reads the same shift-clicking upwards', async () => {
    await startSelecting()

    tile(nth(9)).click()
    await screen.findByText('1 selected')
    fireEvent.click(tile(nth(0)), { shiftKey: true })

    expect(await screen.findByText('10 selected')).toBeTruthy()
  })

  it('adds a second run rather than replacing the first', async () => {
    await startSelecting()

    tile(nth(0)).click()
    fireEvent.click(tile(nth(2)), { shiftKey: true })
    await screen.findByText('3 selected')

    tile(nth(10)).click()
    fireEvent.click(tile(nth(12)), { shiftKey: true })

    expect(await screen.findByText('6 selected')).toBeTruthy()
  })

  it('shift with nothing picked yet is an ordinary pick', async () => {
    // No anchor to measure from, so there is no run to take.
    await startSelecting()
    fireEvent.click(tile(nth(4)), { shiftKey: true })
    expect(await screen.findByText('1 selected')).toBeTruthy()
  })

  it('drops the selection on leaving the mode', async () => {
    // Keeping it would leave an invisible set of pictures that a later action
    // could run over, which is the surprise the mode exists to prevent.
    await startSelecting()
    tile(nth(0)).click()
    await screen.findByText('1 selected')

    screen.getByRole('button', { name: 'Selecting' }).click()
    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())

    screen.getByRole('button', { name: 'Select' }).click()
    expect(await screen.findByText('Nothing selected')).toBeTruthy()
  })

  it('clears, and selects everything shown', async () => {
    await startSelecting()

    screen.getByRole('button', { name: `Select all ${PAGE}` }).click()
    expect(await screen.findByText(`${PAGE} selected`)).toBeTruthy()

    screen.getByRole('button', { name: 'Clear' }).click()
    expect(await screen.findByText('Nothing selected')).toBeTruthy()
  })
})

describe('the lightbox shortcuts a review pass leans on', () => {
  // Wrapped, unlike `fireEvent`, which Testing Library wraps for you. Three raw
  // dispatches in a row never let React re-render between them, so every one
  // would be handled by the closure the first render made — and three presses
  // meant for three pictures would all land on the first.
  function press(key: string) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  async function openFirst() {
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })
  }

  it('rates four on arrow-up and moves on', async () => {
    // Four rather than five: five is a favourite and deserves a deliberate
    // keypress, four is the judgement you make dozens of times in a pass.
    // Three presses rate three pictures, not one three times.
    await openFirst()
    press('ArrowUp')
    press('ArrowUp')
    press('ArrowUp')

    await waitFor(() =>
      expect(starCalls).toEqual([
        { id: LIBRARY_SIZE, stars: 4 },
        { id: LIBRARY_SIZE - 1, stars: 4 },
        { id: LIBRARY_SIZE - 2, stars: 4 },
      ]),
    )
  })

  it('shows the rating it just applied before moving on', async () => {
    // The star redraws locally rather than after a round-trip, so a held key
    // does not feel like it missed.
    await openFirst()
    press('ArrowUp')
    press('ArrowLeft')
    expect(screen.getByRole('button', { name: '4 stars' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('leaves 1-5 where they are, for adjusting a rating just given', async () => {
    // The digits are the escape hatch from the advance: press 4 by mistake and
    // 5 has to fix it, which it cannot do from the next picture.
    await openFirst()
    press('3')
    await waitFor(() => expect(starCalls).toEqual([{ id: LIBRARY_SIZE, stars: 3 }]))
    press('5')
    await waitFor(() =>
      expect(starCalls).toEqual([
        { id: LIBRARY_SIZE, stars: 3 },
        { id: LIBRARY_SIZE, stars: 5 },
      ]),
    )
  })

  it('picks the open picture on arrow-down, and shows it once you are back', async () => {
    // The whole point of doing it from the lightbox: stopping to close it, find
    // the tile and click it turns a judgement into an errand.
    await openFirst()
    press('ArrowDown')

    screen.getByRole('button', { name: 'Close' }).click()

    // The mode came on by itself, so the selection is visible and refinable
    // rather than an invisible set nothing can act on.
    expect(await screen.findByText('1 selected')).toBeTruthy()
    expect(
      screen.getByTitle(`image-${LIBRARY_SIZE}.png`).getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('refines that selection in the grid', async () => {
    await openFirst()
    press('ArrowDown')
    screen.getByRole('button', { name: 'Close' }).click()
    await screen.findByText('1 selected')

    // Shift-click from the row picked in the lightbox — the anchor came with it.
    fireEvent.click(screen.getByTitle(`image-${LIBRARY_SIZE - 4}.png`), { shiftKey: true })
    expect(await screen.findByText('5 selected')).toBeTruthy()
  })

  it('moves on after picking, so a pass is one key', async () => {
    // Picking is nearly always followed by moving on. Three presses should be
    // three pictures, not one picked three times.
    await openFirst()
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowDown')
    screen.getByRole('button', { name: 'Close' }).click()

    expect(await screen.findByText('3 selected')).toBeTruthy()
    for (const index of [0, 1, 2]) {
      expect(
        screen.getByTitle(`image-${LIBRARY_SIZE - index}.png`).getAttribute('aria-pressed'),
      ).toBe('true')
    }
    // And stopped there — the fourth was never reached.
    expect(screen.getByTitle(`image-${LIBRARY_SIZE - 3}.png`).getAttribute('aria-pressed')).toBeNull()
  })

  it('still unpicks when you come back to one already picked', async () => {
    // The advance does not make it one-way: left, then down again, takes it out.
    await openFirst()
    press('ArrowDown')
    press('ArrowLeft')
    press('ArrowDown')
    screen.getByRole('button', { name: 'Close' }).click()

    expect(await screen.findByText('Nothing selected')).toBeTruthy()
  })
})

describe('starting selection with a tap of Ctrl', () => {
  const ctrlDown = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', bubbles: true }))
    })
  const ctrlUp = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }))
    })

  it('turns the mode on as the key goes down, not when it comes back up', async () => {
    // Waiting for the release is correct and feels broken: the mode should be
    // there by the time you have finished pressing.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    expect(screen.queryByText('Nothing selected')).toBeNull()

    ctrlDown()

    expect(screen.getByText('Nothing selected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Selecting' })).toBeTruthy()
  })

  it('takes it back when the Ctrl was the start of a combination', async () => {
    // Ctrl-K focuses the search. The mode flicks on and straight off again,
    // which is the price of not lagging on the common case.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    ctrlDown()
    expect(screen.getByText('Nothing selected')).toBeTruthy()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    })
    ctrlUp()

    expect(screen.queryByText('Nothing selected')).toBeNull()
  })

  it('takes it back on a Ctrl-click too', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    ctrlDown()
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerdown', { ctrlKey: true, bubbles: true }))
    })
    ctrlUp()

    expect(screen.queryByText('Nothing selected')).toBeNull()
  })

  it('leaves a mode that was already on alone', async () => {
    // Taking it back would discard the selection, so Ctrl-C in the middle of
    // picking must not touch it.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')
    screen.getByTitle(`image-${LIBRARY_SIZE}.png`).click()
    await screen.findByText('1 selected')

    ctrlDown()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    })
    ctrlUp()

    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('does not throw away a selection already made', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    ctrlDown()
    ctrlUp()
    screen.getByTitle(`image-${LIBRARY_SIZE}.png`).click()
    await screen.findByText('1 selected')

    ctrlDown()
    ctrlUp()

    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('stays out of the lightbox, which owns its own keyboard', async () => {
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })

    ctrlDown()
    ctrlUp()
    screen.getByRole('button', { name: 'Close' }).click()

    await waitFor(() => expect(screen.queryByRole('group', { name: 'Rating' })).toBeNull())
    expect(screen.queryByText('Nothing selected')).toBeNull()
  })
})

describe('deleting a selection', () => {
  const nth = (index: number) => LIBRARY_SIZE - index

  async function selectThree() {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')
    screen.getByTitle(`image-${nth(0)}.png`).click()
    fireEvent.click(screen.getByTitle(`image-${nth(2)}.png`), { shiftKey: true })
    await screen.findByText('3 selected')
  }

  it('asks once for the whole set, and says how permanent it is', async () => {
    await selectThree()
    screen.getByRole('button', { name: 'Delete 3' }).click()

    // Every path in this library is a share, where there is no bin to promise.
    expect(await screen.findByText('Delete permanently?')).toBeTruthy()
    expect(screen.getByText(/3 files\./)).toBeTruthy()

    screen.getByRole('button', { name: 'Delete permanently' }).click()
    await waitFor(() => expect(deleteBatches).toHaveLength(1))
    expect([...deleteBatches[0]!.ids].sort((a, b) => b - a)).toEqual([nth(0), nth(1), nth(2)])
    expect(deleteBatches[0]!.permanent).toBe(true)
  })

  it('clears the selection afterwards', async () => {
    await selectThree()
    screen.getByRole('button', { name: 'Delete 3' }).click()
    ;(await screen.findByRole('button', { name: 'Delete permanently' })).click()

    await waitFor(() => expect(screen.getByText('Nothing selected')).toBeTruthy())
  })

  it('deletes nothing when the question is declined', async () => {
    await selectThree()
    screen.getByRole('button', { name: 'Delete 3' }).click()
    ;(await screen.findByRole('button', { name: 'Cancel' })).click()

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleteBatches).toHaveLength(0)
    expect(screen.getByText('3 selected')).toBeTruthy()
  })
})

describe('upscaling a selection', () => {
  const tile = (id: number) => screen.getByTitle(`image-${id}.png`)
  const nth = (index: number) => LIBRARY_SIZE - index

  async function selectTwo() {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')
    tile(nth(0)).click()
    fireEvent.click(tile(nth(1)), { shiftKey: true })
    await screen.findByText('2 selected')
  }

  it('is reachable from the selection bar and sends what was picked', async () => {
    await selectTwo()

    screen.getByRole('button', { name: 'Upscale 2 to 4K' }).click()

    await waitFor(() => expect(upscaleCalls).toHaveLength(1))
    expect([...upscaleCalls[0]!].sort((a, b) => b - a)).toEqual([nth(0), nth(1)])
  })

  it('shows what came out, with the numbers', async () => {
    // "Done" alone does not answer the question a person actually has after
    // minutes of GPU work, which is whether it came out well.
    await selectTwo()
    screen.getByRole('button', { name: 'Upscale 2 to 4K' }).click()

    expect(await screen.findByText('2 upscaled')).toBeTruthy()
    expect(screen.getByText('4x-AnimeSharp.pth')).toBeTruthy()
    expect(screen.getAllByText('896×1192 → 2886×3840')).toHaveLength(2)

    screen.getByRole('button', { name: 'Close' }).click()
    await waitFor(() => expect(screen.queryByText('2 upscaled')).toBeNull())
  })

  it('also closes on Escape', async () => {
    // The panel covers the whole window. If its one button ever fails to
    // register there is no route back to the grid at all, so there are three.
    await selectTwo()
    screen.getByRole('button', { name: 'Upscale 2 to 4K' }).click()
    await screen.findByText('2 upscaled')

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    await waitFor(() => expect(screen.queryByText('2 upscaled')).toBeNull())
  })

  it('cannot be started with nothing picked', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')

    const button = screen.getByRole('button', { name: 'Upscale 0 to 4K' })
    expect(button.hasAttribute('disabled')).toBe(true)
    button.click()
    expect(upscaleCalls).toHaveLength(0)
  })
})

describe('the favourites filter', () => {
  const heart = () => screen.getByRole('button', { name: 'Favourites only' })
  const fourPlus = () => screen.getByRole('button', { name: '★ 4+' })
  const lastQuery = () => queries.at(-1)

  it('asks the backend for five stars, which is the top of the scale', async () => {
    // Not a separate favourites column: five is already the most a person can
    // give, so "at least five" is exactly five and the rating carries it.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    heart().click()
    await waitFor(() => expect(lastQuery()?.minStars).toBe(5))
    expect(heart().getAttribute('aria-pressed')).toBe('true')
  })

  it('toggles back off', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    heart().click()
    await waitFor(() => expect(lastQuery()?.minStars).toBe(5))
    heart().click()
    await waitFor(() => expect(lastQuery()?.minStars).toBeNull())
    expect(heart().getAttribute('aria-pressed')).toBe('false')
  })

  it('replaces the 4+ filter rather than fighting it', async () => {
    // One value, two settings of it. Two independent filters could both be on
    // and would then have to mean something, which "4 or more and exactly 5"
    // does not.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    fourPlus().click()
    await waitFor(() => expect(lastQuery()?.minStars).toBe(4))
    expect(heart().getAttribute('aria-pressed')).toBe('false')

    heart().click()
    await waitFor(() => expect(lastQuery()?.minStars).toBe(5))
    expect(fourPlus().getAttribute('aria-pressed')).toBe('false')
    expect(heart().getAttribute('aria-pressed')).toBe('true')
  })

  it('shows only the five-star pictures', async () => {
    // Against a backend that actually filters, so this covers the round trip
    // rather than just the value leaving the filter bar.
    library[0]!.stars = 5
    library[1]!.stars = 4
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    heart().click()

    await waitFor(() => expect(screen.queryAllByTitle(`image-${LIBRARY_SIZE - 1}.png`)).toHaveLength(0))
    expect(screen.getByTitle(`image-${LIBRARY_SIZE}.png`)).toBeTruthy()
  })
})

describe('the 4K filter', () => {
  const fourK = () => screen.getByRole('button', { name: '4K' })

  it('sends the same threshold the badge uses', async () => {
    // A number, not a name. If the filter said "fourKOnly" the index would own
    // a second definition of 4K, and the two would eventually disagree.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    fourK().click()
    await waitFor(() => expect(queries.at(-1)?.minLongestEdge).toBe(3840))
    expect(fourK().getAttribute('aria-pressed')).toBe('true')

    fourK().click()
    await waitFor(() => expect(queries.at(-1)?.minLongestEdge).toBeNull())
  })

  it('is independent of the star filters', async () => {
    // Size and judgement are different questions, so unlike the two star pills
    // these compose rather than replace each other.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    screen.getByRole('button', { name: 'Favourites only' }).click()
    await waitFor(() => expect(queries.at(-1)?.minStars).toBe(5))
    fourK().click()

    await waitFor(() => {
      expect(queries.at(-1)?.minLongestEdge).toBe(3840)
      expect(queries.at(-1)?.minStars).toBe(5)
    })
  })
})

describe('deleting with the Delete key', () => {
  /** A real key press: bare, on the document, not a repeat. */
  function press(key: string, init: KeyboardEventInit = {}) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  }

  it('opens the same question the button does, and a second Delete answers it', async () => {
    render(<App />)
    const doomed = `image-${LIBRARY_SIZE}.png`
    ;(await screen.findByTitle(doomed)).click()
    await screen.findByRole('group', { name: 'Rating' })

    press('Delete')
    // Every path in this library is a share, where there is no bin to promise.
    expect(await screen.findByText('Delete permanently?')).toBeTruthy()

    // The key that raised the question answers it. Reaching for Enter instead
    // would be two reaches for one decision.
    press('Delete')
    await waitFor(() => expect(deleteCalls).toEqual([{ id: LIBRARY_SIZE, permanent: true }]))
  })

  it('ignores auto-repeat, so holding Delete cannot ask and answer at once', async () => {
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })

    press('Delete')
    await screen.findByText('Delete permanently?')

    // What a held key sends. Answering on one of these would delete a file
    // behind a question nobody had time to read.
    press('Delete', { repeat: true })
    press('Delete', { repeat: true })
    await waitFor(() => expect(screen.queryByText('Delete permanently?')).toBeTruthy())
    expect(deleteCalls).toHaveLength(0)
  })

  it('still cancels on Escape', async () => {
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })

    press('Delete')
    await screen.findByText('Delete permanently?')
    press('Escape')

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleteCalls).toHaveLength(0)
    // And the Escape that dismissed the dialog must not also close the lightbox
    // behind it — the dialog swallows keys in the capture phase.
    expect(screen.queryByRole('group', { name: 'Rating' })).toBeTruthy()
  })

  it('does not fire while something is being typed into', async () => {
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })

    const field = document.createElement('input')
    document.body.append(field)
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))

    await waitFor(() => expect(screen.queryByText('Delete permanently?')).toBeNull())
    field.remove()
  })
})

describe('deleting from the lightbox', () => {
  it('removes the file from the recently-added strip without a reload', async () => {
    render(<App />)

    // The newest file, which is the first tile in the strip.
    const doomed = `image-${LIBRARY_SIZE}.png`
    const tile = await screen.findByTitle(doomed)
    expect(screen.getAllByTitle(doomed).length).toBeGreaterThan(0)

    tile.click()
    const remove = await screen.findByRole('button', { name: 'Delete' })
    remove.click()

    const confirm = await screen.findByRole('button', { name: 'Delete permanently' })
    confirm.click()

    await waitFor(() => {
      expect(screen.queryAllByTitle(doomed)).toHaveLength(0)
    })

    // The grid is still a full page, so its length says nothing changed — which
    // is exactly why the strip cannot be refreshed off it.
    expect(library).toHaveLength(LIBRARY_SIZE - 1)
    expect(library.length).toBeGreaterThan(PAGE)
  })

  it('asks permanently, and says so to the backend, for a file on a share', async () => {
    render(<App />)

    const doomed = `image-${LIBRARY_SIZE}.png`
    ;(await screen.findByTitle(doomed)).click()
    ;(await screen.findByRole('button', { name: 'Delete' })).click()

    // Every path in this library is a share, where there is no bin to promise.
    expect(await screen.findByText('Delete permanently?')).toBeTruthy()
    ;(await screen.findByRole('button', { name: 'Delete permanently' })).click()

    await waitFor(() => {
      expect(deleteCalls).toEqual([{ id: LIBRARY_SIZE, permanent: true }])
    })
  })

  it('leaves the file alone when the confirmation is declined', async () => {
    render(<App />)

    const doomed = `image-${LIBRARY_SIZE}.png`
    ;(await screen.findByTitle(doomed)).click()
    ;(await screen.findByRole('button', { name: 'Delete' })).click()
    ;(await screen.findByRole('button', { name: 'Cancel' })).click()

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(deleteCalls).toHaveLength(0)
    expect(library).toHaveLength(LIBRARY_SIZE)
  })
})
