import type { MediaItem } from '@luma/core'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  }
}

/** Newest first, which is what both the strip and the grid ask for. */
let library: MediaItem[] = []
const deleteCalls: Array<{ id: number; permanent: boolean }> = []
const starCalls: Array<{ id: number; stars: number | null }> = []

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
  queryMedia: (query: { offset: number; limit: number }) =>
    Promise.resolve({
      items: library.slice(query.offset, query.offset + query.limit),
      total: library.length,
      offset: query.offset,
    }),
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
}))

beforeEach(() => {
  library = Array.from({ length: LIBRARY_SIZE }, (_, index) => makeItem(LIBRARY_SIZE - index))
  deleteCalls.length = 0
  starCalls.length = 0
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
