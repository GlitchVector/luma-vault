import type { MediaItem } from '@luma/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogs } from '#/lib/dialogs.ts'
import { resetInViewRegistry } from '#/lib/useInView.ts'
import { App, DOUBLE_TAP_MS, FORGE_RETRY_MS } from './App.tsx'

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
    deviantArt: null,
    ratingOverride: null,
  }
}

/** Newest first, which is what both the strip and the grid ask for. */
let library: MediaItem[] = []
const deleteCalls: Array<{ id: number; permanent: boolean }> = []
const starCalls: Array<{ id: number; stars: number | null }> = []
/** Each batch rating, so one call for the whole selection can be asserted. */
const starBatches: Array<{ ids: number[]; stars: number | null }> = []
/** Every query the timeline asked with, so its shape can be asserted. */
const timelineQueries: Array<Record<string, unknown>> = []
/** When set, the next timeline fetches reject with this message. */
let timelineFailure: string | null = null
/** The character leaderboard the sidebar shows. Empty unless a case sets it. */
let topCharactersState: Array<{ name: string; count: number }> = []
/** Every query the leaderboard was asked with, so following can be asserted. */
const topCharacterQueries: Array<Record<string, unknown>> = []
/** Every query the grid asked the backend for, so a filter can be checked end to end. */
const queries: Array<{ minStars?: number | null; minLongestEdge?: number | null }> = []
/** Ids each upscale run was asked for. */
const upscaleCalls: number[][] = []
/** What Forge claims to be doing, for the upscale gate. */
let forgeState = { reachable: true, busy: false, job: null as string | null, progress: 0 }
/** Which library the window is showing. Local unless a case says otherwise. */
let remoteState = {
  connected: false,
  address: '',
  host: '',
  folders: 0,
  items: 0,
  lastAddress: '',
  hasPassphrase: false,
}
let shareState = { sharing: false, port: 7870, addresses: [] as string[], hasPassphrase: false }
/** Each batch delete, so one call for the whole set can be asserted. */
const deleteBatches: Array<{ ids: number[]; permanent: boolean }> = []
/** What the DeviantArt panel actually asked the backend to upload. */
const deviantArtSends: Array<{ drafts: unknown[]; publish: boolean; stack: string | null }> = []
/** Swapped per test: connected, upload-only, or not set up at all. */
let deviantArtAccountState = {
  configured: true,
  connected: true,
  username: 'glitchvector',
  clientId: '12345',
  redirectUri: 'http://localhost:14340/deviantart',
  scopes: ['basic', 'stash', 'publish'],
  canPublish: true,
}

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
  mediaTimeline: (query: Record<string, unknown>) => {
    timelineQueries.push(query)
    if (timelineFailure) return Promise.reject(new Error(timelineFailure))
    // Weekly counts over whatever the fake library holds, mirroring the real
    // SQL: Monday buckets, empty weeks absent, zero mtimes excluded.
    const WEEK = 7 * 24 * 60 * 60 * 1000
    const SHIFT = 3 * 24 * 60 * 60 * 1000
    const counts = new Map<number, number>()
    for (const item of library) {
      if (item.modifiedAt <= 0) continue
      const week = Math.floor((item.modifiedAt + SHIFT) / WEEK)
      counts.set(week, (counts.get(week) ?? 0) + 1)
    }
    return Promise.resolve(
      [...counts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([week, count]) => ({ start: week * WEEK - SHIFT, count })),
    )
  },
  mediaById: (id: number) => Promise.resolve(library.find((item) => item.id === id) ?? null),
  mediaFrames: () => Promise.resolve([]),
  extrasOriginal: () => Promise.resolve(null),
  sourceOrigin: () => Promise.resolve(null),
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
  topCharacters: (query: Record<string, unknown>, limit: number) => {
    topCharacterQueries.push({ ...query, askedLimit: limit })
    return Promise.resolve(topCharactersState)
  },
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
  setStarsMany: (ids: number[], stars: number | null) => {
    starBatches.push({ ids, stars })
    for (const id of ids) {
      const row = library.find((item) => item.id === id)
      if (row) row.stars = stars
    }
    return Promise.resolve(ids.length)
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
  forgeStatus: () => Promise.resolve(forgeState),
  remoteStatus: () => Promise.resolve(remoteState),
  remoteConnect: () => Promise.resolve(remoteState),
  remoteDisconnect: () => Promise.resolve(remoteState),
  shareStatus: () => Promise.resolve(shareState),
  setShare: () => Promise.resolve(shareState),
  DEVIANTART_STUDIO_URL: 'https://www.deviantart.com/studio',
  DEVIANTART_APPS_URL: 'https://www.deviantart.com/developers/apps',
  deviantArtAccount: () => Promise.resolve(deviantArtAccountState),
  deviantArtConfigure: () => Promise.resolve(deviantArtAccountState),
  deviantArtSetRedirect: () => Promise.resolve(),
  deviantArtConnect: () => Promise.resolve(deviantArtAccountState),
  deviantArtDisconnect: () => Promise.resolve(),
  onDeviantArtProgress: () => Promise.resolve(() => {}),
  deviantArtSend: (drafts: unknown[], publish: boolean, stack: string | null) => {
    deviantArtSends.push({ drafts, publish, stack })
    return Promise.resolve({
      staged: drafts.length,
      published: publish ? drafts.length : 0,
      failed: 0,
      results: [],
    })
  },
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
  starBatches.length = 0
  timelineQueries.length = 0
  timelineFailure = null
  topCharactersState = []
  topCharacterQueries.length = 0
  queries.length = 0
  upscaleCalls.length = 0
  deleteBatches.length = 0
  deviantArtSends.length = 0
  deviantArtAccountState = {
    configured: true,
    connected: true,
    username: 'glitchvector',
    clientId: '12345',
    redirectUri: 'http://localhost:14340/deviantart',
    scopes: ['basic', 'stash', 'publish'],
    canPublish: true,
  }
  forgeState = { reachable: true, busy: false, job: null, progress: 0 }
  remoteState = {
    connected: false,
    address: '',
    host: '',
    folders: 0,
    items: 0,
    lastAddress: '',
    hasPassphrase: false,
  }
  shareState = { sharing: false, port: 7870, addresses: [], hasPassphrase: false }
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

describe('opening the lightbox', () => {
  it('does not draw detection boxes until asked', async () => {
    // A diagnostic view answering "why was this rated that way" — a question you
    // occasionally have and never have by default. Opening a picture should show
    // the picture.
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()

    expect(await screen.findByRole('button', { name: 'Show boxes' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Hide boxes' })).toBeNull()
  })

  it('keeps the choice across openings once it is made', async () => {
    // The toggle lives in the app rather than the lightbox precisely so it
    // survives closing one — turning it on for every file in a folder would
    // make it useless for the case it exists for.
    render(<App />)
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)).click()
    ;(await screen.findByRole('button', { name: 'Show boxes' })).click()
    await screen.findByRole('button', { name: 'Hide boxes' })

    screen.getByRole('button', { name: 'Close' }).click()
    ;(await screen.findByTitle(`image-${LIBRARY_SIZE - 1}.png`)).click()

    expect(await screen.findByRole('button', { name: 'Hide boxes' })).toBeTruthy()
  })
})

describe('the lightbox shortcuts a review pass leans on', () => {
  // Wrapped, unlike `fireEvent`, which Testing Library wraps for you. Three raw
  // dispatches in a row never let React re-render between them, so every one
  // would be handled by the closure the first render made — and three presses
  // meant for three pictures would all land on the first.
  function press(key: string, init: KeyboardEventInit = {}) {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      )
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

  it('shift-up rates, moves on, and queues a 4K upscale', async () => {
    // The same verdict as a plain arrow-up with one more consequence: this one
    // is worth the pixels. One motion, without leaving the pass to find a
    // button.
    await openFirst()
    press('ArrowUp', { shiftKey: true })

    await waitFor(() => expect(starCalls).toEqual([{ id: LIBRARY_SIZE, stars: 4 }]))
    await waitFor(() => expect(upscaleCalls).toEqual([[LIBRARY_SIZE]]))
  })

  it('leaves plain arrow-up spending no GPU at all', async () => {
    // The shift is the whole difference. A pass through a folder rating things
    // four must not quietly start upscaling every one of them.
    await openFirst()
    press('ArrowUp')

    await waitFor(() => expect(starCalls).toEqual([{ id: LIBRARY_SIZE, stars: 4 }]))
    expect(upscaleCalls).toEqual([])
  })

  it('does not upscale a picture that is already 4K', async () => {
    // Minutes of GPU to produce a file that exists. Still rates it and still
    // moves on — the verdict half of the key is unconditional.
    library[0] = { ...library[0]!, width: 3840, height: 2160 }
    await openFirst()
    press('ArrowUp', { shiftKey: true })

    await waitFor(() => expect(starCalls).toEqual([{ id: LIBRARY_SIZE, stars: 4 }]))
    expect(await screen.findByText(/already 4K/)).toBeTruthy()
    expect(upscaleCalls).toEqual([])
  })

  it('does not upscale one that already has a 4K version', async () => {
    library[0] = { ...library[0]!, upscaledTo: '/media/image-320_upscaled_4k.png' }
    await openFirst()
    press('ArrowUp', { shiftKey: true })

    await waitFor(() => expect(starCalls).toEqual([{ id: LIBRARY_SIZE, stars: 4 }]))
    expect(upscaleCalls).toEqual([])
  })

  it('holds a queued upscale back until Forge has finished generating', async () => {
    // Both want the whole card. The keypress still means something — the
    // picture is remembered and started once the GPU is free, so a review pass
    // never has to care what Forge is doing.
    forgeState = { reachable: true, busy: true, job: 'Batch 3 out of 3', progress: 0.85 }
    await openFirst()

    vi.useFakeTimers()
    try {
      press('ArrowUp', { shiftKey: true })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FORGE_RETRY_MS * 2)
      })
      expect(upscaleCalls).toEqual([])

      forgeState = { reachable: true, busy: false, job: null, progress: 0 }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FORGE_RETRY_MS + 100)
      })
      expect(upscaleCalls).toEqual([[LIBRARY_SIZE]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs a burst one picture at a time rather than all at once', async () => {
    // The upscaler wants the whole card, so three shift-ups are three runs in
    // turn — never one call carrying three, and never three at once.
    await openFirst()
    press('ArrowUp', { shiftKey: true })
    press('ArrowUp', { shiftKey: true })
    press('ArrowUp', { shiftKey: true })

    await waitFor(() => expect(upscaleCalls.length).toBe(3))
    expect(upscaleCalls).toEqual([[LIBRARY_SIZE], [LIBRARY_SIZE - 1], [LIBRARY_SIZE - 2]])
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
  // A real click fires pointerdown first; `fireEvent.click` fires only the
  // click. That ordering is the whole mechanism here — pointerdown is what
  // tells the Ctrl handler the mode is being used rather than started — so the
  // sequence has to be the real one or the test proves nothing.
  const clickTile = (id: number) => {
    const tile = screen.getByTitle(`image-${id}.png`)
    fireEvent.pointerDown(tile, { ctrlKey: true, button: 0 })
    fireEvent.click(tile, { ctrlKey: true })
  }

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

  it('lets you keep holding Ctrl and pick, which is the point', async () => {
    // The flow this shortcut is for: hold Ctrl, click a few pictures, let go.
    // Taking the mode back on the click fired *before* the tile was handled, so
    // the click opened the lightbox instead of selecting.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    ctrlDown()
    clickTile(LIBRARY_SIZE)

    expect(await screen.findByText('1 selected')).toBeTruthy()
    expect(screen.queryByRole('group', { name: 'Rating' })).toBeNull()

    // Still holding Ctrl, and a second picture picks rather than opening.
    clickTile(LIBRARY_SIZE - 1)
    expect(await screen.findByText('2 selected')).toBeTruthy()
    ctrlUp()
    expect(screen.getByText('2 selected')).toBeTruthy()
  })

  it('is safe from a combination once picking has started', async () => {
    // Ctrl is still down after the first pick. A Ctrl-C now must not revoke a
    // mode that is visibly in use with a selection in it.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    ctrlDown()
    clickTile(LIBRARY_SIZE)
    await screen.findByText('1 selected')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
    })
    ctrlUp()

    expect(screen.getByText('1 selected')).toBeTruthy()
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
    // The click goes through the real sequence — pointerdown, then click —
    // because that ordering is now load-bearing twice over: it tells the
    // handler the mode is being used, and it separates the tap before it from
    // the tap after, which would otherwise pair into a double tap and discard
    // the very selection this is about.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    ctrlDown()
    ctrlUp()
    const tile = screen.getByTitle(`image-${LIBRARY_SIZE}.png`)
    fireEvent.pointerDown(tile, { button: 0 })
    fireEvent.click(tile)
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

  it('a double tap of Ctrl leaves the mode and drops the selection', async () => {
    // Tapping Ctrl once never leaves the mode — that guard is tested above.
    // The deliberate way out is tapping it twice: two bare taps inside the
    // window do what the toolbar button does, mode off and selection gone.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    ctrlDown()
    clickTile(LIBRARY_SIZE)
    await screen.findByText('1 selected')
    ctrlUp()

    ctrlDown()
    ctrlUp()
    ctrlDown()
    ctrlUp()

    expect(screen.queryByText('1 selected')).toBeNull()
    expect(screen.queryByText('Nothing selected')).toBeNull()
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy()
  })

  it('two taps too far apart are two taps, not a double', async () => {
    // The second tap has to arrive inside the window. Past it, this is just
    // someone turning the mode on twice.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    ctrlDown()
    clickTile(LIBRARY_SIZE)
    await screen.findByText('1 selected')
    ctrlUp()

    vi.useFakeTimers()
    try {
      ctrlDown()
      ctrlUp()
      act(() => {
        vi.advanceTimersByTime(DOUBLE_TAP_MS + 50)
      })
      ctrlDown()
      ctrlUp()
    } finally {
      vi.useRealTimers()
    }

    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('a tap used for picking is not a tap, so it cannot pair', async () => {
    // Hold Ctrl, click a picture, let go — then tap Ctrl. The click makes the
    // first press a *use* of the mode rather than a tap, so the tap after it
    // has nothing to pair with and the mode must survive.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    ctrlDown()
    clickTile(LIBRARY_SIZE)
    ctrlUp()
    await screen.findByText('1 selected')

    ctrlDown()
    ctrlUp()

    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('survives a keyup lost to another window', async () => {
    // Press Ctrl, click over into Forge on the other monitor, come back: the
    // keyup landed there and never arrived here. A stale "already down" flag
    // used to eat every following press whole — no mode, no exit, no error.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')

    ctrlDown() // its keyup is never delivered
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })

    ctrlDown()
    ctrlUp()
    ctrlDown()
    ctrlUp()

    expect(screen.queryByText('Nothing selected')).toBeNull()
    expect(screen.getByRole('button', { name: 'Select' })).toBeTruthy()
  })

  it('a keypress between two taps separates them', async () => {
    // Tap Ctrl, type something, tap Ctrl. Two taps with a keystroke between
    // them are two taps, whatever the clock says — the same rule a click
    // follows, and the reason the search box cannot swallow a selection.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    ctrlDown()
    clickTile(LIBRARY_SIZE)
    await screen.findByText('1 selected')
    ctrlUp()

    ctrlDown()
    ctrlUp()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
    })
    ctrlDown()
    ctrlUp()

    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('a combination is not a tap, so Ctrl-C then Ctrl-V keeps the selection', async () => {
    // The failure this guards: two combinations typed in quick succession are
    // four Ctrl events inside the window. If a press with another key on it
    // counted as a tap, a copy-paste would silently destroy a set assembled by
    // hand.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    ctrlDown()
    clickTile(LIBRARY_SIZE)
    await screen.findByText('1 selected')
    ctrlUp()

    for (const key of ['c', 'v']) {
      ctrlDown()
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }))
      })
      ctrlUp()
    }

    expect(screen.getByText('1 selected')).toBeTruthy()
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

  it('says how many files a pair actually costs', async () => {
    // The backend takes both halves, so "3 files" over a selection of variants
    // would remove six. A confirmation that undercounts is worse than none.
    library[0]!.upscaledFrom = '/media/original-a.png'
    library[1]!.upscaledFrom = '/media/original-b.png'
    await selectThree()

    screen.getByRole('button', { name: 'Delete 3' }).click()

    expect(await screen.findByText(/3 pictures, 5 files/)).toBeTruthy()
    expect(screen.getByText(/2 of them also have a 4K version/)).toBeTruthy()
  })

  it('counts plainly when nothing is paired', async () => {
    await selectThree()
    screen.getByRole('button', { name: 'Delete 3' }).click()
    expect(await screen.findByText(/^3 files\.$/)).toBeTruthy()
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

  it('refuses to compete with a running generation', async () => {
    // Both want the whole GPU. Running them together does not fail, it just
    // makes each take about twice as long — which is worse than waiting.
    forgeState = { reachable: true, busy: true, job: 'Batch 3 out of 3', progress: 0.85 }
    await selectTwo()

    const button = await screen.findByRole('button', { name: 'Forge is busy' })
    expect(button.hasAttribute('disabled')).toBe(true)
    button.click()
    expect(upscaleCalls).toHaveLength(0)
  })

  it('is unblocked by a Forge that is simply not running', async () => {
    // Unreachable is not busy. A gate that fires when the thing it guards
    // against is switched off is just a broken button.
    forgeState = { reachable: false, busy: false, job: null, progress: 0 }
    await selectTwo()

    expect(await screen.findByRole('button', { name: 'Upscale 2 to 4K' })).toBeTruthy()
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

describe('sending a selection to DeviantArt', () => {
  const nth = (index: number) => LIBRARY_SIZE - index

  async function selectTwo() {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')
    screen.getByTitle(`image-${nth(0)}.png`).click()
    fireEvent.click(screen.getByTitle(`image-${nth(1)}.png`), { shiftKey: true })
    await screen.findByText('2 selected')
  }

  async function openPanel() {
    await selectTwo()
    screen.getByRole('button', { name: 'DeviantArt…' }).click()
    await screen.findByText('2 to review')
  }

  it('reviews before anything leaves the machine', async () => {
    await openPanel()
    // The panel is a review step, not a send. Opening it must upload nothing.
    expect(deviantArtSends).toHaveLength(0)
  })

  it('stages privately by default, and posts only on the other button', async () => {
    // These are genuinely different decisions, so they are two buttons. An
    // upload can be abandoned by never posting it; a post cannot.
    await openPanel()
    screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).click()

    await waitFor(() => expect(deviantArtSends).toHaveLength(1))
    expect(deviantArtSends[0]!.publish).toBe(false)
    expect(deviantArtSends[0]!.drafts).toHaveLength(2)
  })

  it('posts publicly when asked to', async () => {
    await openPanel()
    screen.getByRole('button', { name: 'Upload and post' }).click()

    await waitFor(() => expect(deviantArtSends).toHaveLength(1))
    expect(deviantArtSends[0]!.publish).toBe(true)
  })

  it('sends the edited title rather than the derived one', async () => {
    // The whole point of the panel. Re-deriving on the backend would discard
    // every correction someone just made.
    await openPanel()
    const title = screen.getAllByPlaceholderText('Title')[0]!
    fireEvent.change(title, { target: { value: 'A Better Name' } })

    screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).click()
    await waitFor(() => expect(deviantArtSends).toHaveLength(1))

    const drafts = deviantArtSends[0]!.drafts as Array<{ title: string }>
    expect(drafts[0]!.title).toBe('A Better Name')
  })

  it('normalises tags to what DeviantArt accepts', async () => {
    // Their rule is letters, digits and underscores. A stray character is a
    // rejected submission, so the panel shows the normalised form and sends it.
    await openPanel()
    const tags = screen.getAllByPlaceholderText('tags for this picture, separated by commas')[0]!
    fireEvent.change(tags, { target: { value: 'sci-fi!, Blue Hair' } })

    screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).click()
    await waitFor(() => expect(deviantArtSends).toHaveLength(1))

    const drafts = deviantArtSends[0]!.drafts as Array<{ tags: string[] }>
    expect(drafts[0]!.tags).toEqual(['sci_fi', 'blue_hair'])
  })

  it('puts the shared tags on every picture', async () => {
    await openPanel()
    fireEvent.change(screen.getByPlaceholderText('a series name, a signature…'), {
      target: { value: 'glitchvector' },
    })

    screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).click()
    await waitFor(() => expect(deviantArtSends).toHaveLength(1))

    const drafts = deviantArtSends[0]!.drafts as Array<{ tags: string[] }>
    expect(drafts).toHaveLength(2)
    for (const draft of drafts) expect(draft.tags[0]).toBe('glitchvector')
  })

  it('will not offer to post when the connection cannot', async () => {
    // A connection can be perfectly valid and still lack the publish scope.
    // Offering the button and failing on click would waste a whole upload.
    deviantArtAccountState = { ...deviantArtAccountState, scopes: ['basic', 'stash'], canPublish: false }
    await openPanel()

    expect(await screen.findByText(/did not grant the publish scope/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Upload and post' }).hasAttribute('disabled')).toBe(true)
    // Staging is still fine — that is what the stash scope is for.
    expect(screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).hasAttribute('disabled')).toBe(
      false,
    )
  })

  it('leaves videos out rather than uploading one as an image', async () => {
    library[0]!.kind = 'video'
    await selectTwo()
    screen.getByRole('button', { name: 'DeviantArt…' }).click()

    expect(await screen.findByText('Videos skipped')).toBeTruthy()
    expect(await screen.findByText('1 to review')).toBeTruthy()
  })
})

describe('choosing pose tags from the first picture', () => {
  const nth = (index: number) => LIBRARY_SIZE - index

  /**
   * Give the first picture a verdict, the way the classifier would.
   *
   * `topLabel` is the highest-scoring *rated* detection, which is exactly what
   * the pose rule reads — and it is what an upscaled variant inherits, since a
   * variant never goes through classification and so has no frame rows at all.
   */
  function classifyFirst(topLabel: string | null) {
    library[0]!.verdict = {
      person: true,
      sexy: true,
      nude: false,
      rating: 'suggestive',
      topLabel,
      topLabelTitle: topLabel,
      topScore: 0.8,
      frameCount: 1,
      sexyFrameCount: 1,
      posterFrameIndex: null,
    }
  }

  async function openPanelOverTwo() {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')
    screen.getByTitle(`image-${nth(0)}.png`).click()
    fireEvent.click(screen.getByTitle(`image-${nth(1)}.png`), { shiftKey: true })
    await screen.findByText('2 selected')
    screen.getByRole('button', { name: 'DeviantArt…' }).click()
    await screen.findByText('2 to review')
  }

  async function sentTags() {
    screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).click()
    await waitFor(() => expect(deviantArtSends).toHaveLength(1))
    return (deviantArtSends[0]!.drafts as Array<{ tags: string[] }>).map((draft) => draft.tags)
  }

  it('says from behind when buttocks scored highest', async () => {
    classifyFirst('BUTTOCKS_EXPOSED')
    await openPanelOverTwo()
    // `bigass` is in both lists, so the discriminator is what is *absent*: the
    // rear set drops the four large-breast tags.
    expect(await screen.findByText('bigass')).toBeTruthy()

    for (const tags of await sentTags()) {
      expect(tags).toContain('bubblebutt')
      expect(tags).not.toContain('hugeboobs')
      expect(tags).not.toContain('largebreasts')
    }
  })

  it('says from the front when anything else scored highest', async () => {
    classifyFirst('FEMALE_BREAST_EXPOSED')
    await openPanelOverTwo()

    for (const tags of await sentTags()) {
      expect(tags).toContain('hugeboobs')
      expect(tags).toContain('largebreasts')
    }
  })

  it('works for an upscaled variant, which has no detections of its own', async () => {
    // The case this broke on. A variant inherits its original's verdict but
    // never gets frame rows, and the grid hides an original once a variant
    // exists — so reading raw detections found nothing for nearly every real
    // selection and the pose came back empty every time.
    classifyFirst('BUTTOCKS_EXPOSED')
    library[0]!.upscaledFrom = '/media/image-orig.png'
    await openPanelOverTwo()

    for (const tags of await sentTags()) {
      expect(tags).toContain('bubblebutt')
      expect(tags).not.toContain('hugeboobs')
    }
  })

  it('reads the first picture only, and puts its answer on the whole set', async () => {
    classifyFirst('BUTTOCKS_EXPOSED')
    await openPanelOverTwo()

    const sent = await sentTags()
    expect(sent).toHaveLength(2)
    for (const tags of sent) {
      expect(tags).toContain('bubblebutt')
      expect(tags).not.toContain('hugeboobs')
    }
  })

  it('adds nothing when the first picture was never classified', async () => {
    // Guessing an orientation from nothing would put confident tags on a
    // picture nothing is known about.
    await openPanelOverTwo()

    for (const tags of await sentTags()) {
      expect(tags).not.toContain('bigass')
      expect(tags).not.toContain('hugeboobs')
    }
  })

  it('adds nothing when only the whole-image anime rating was found', async () => {
    // ANIME_* has no location, so it cannot mean from behind or from the front.
    classifyFirst('ANIME_EXPLICIT')
    await openPanelOverTwo()

    for (const tags of await sentTags()) {
      expect(tags).not.toContain('bigass')
      expect(tags).not.toContain('hugeboobs')
    }
  })

  it('can be overridden for the whole batch', async () => {
    classifyFirst('FEMALE_BREAST_EXPOSED')
    await openPanelOverTwo()
    fireEvent.change(screen.getByTitle(/Which set of orientation tags/), {
      target: { value: 'rear' },
    })

    for (const tags of await sentTags()) {
      expect(tags).toContain('bubblebutt')
      expect(tags).not.toContain('hugeboobs')
    }
  })

  it('can be switched off entirely', async () => {
    classifyFirst('BUTTOCKS_EXPOSED')
    await openPanelOverTwo()
    fireEvent.change(screen.getByTitle(/Which set of orientation tags/), {
      target: { value: 'none' },
    })

    for (const tags of await sentTags()) {
      expect(tags).not.toContain('bigass')
      expect(tags).not.toContain('bubblebutt')
    }
  })

  it('groups the batch into a stack named after the batch title', async () => {
    // DeviantArt's API cannot make a multi-image deviation — `stash/publish`
    // takes exactly one `itemid` and `deviation/edit` cannot attach a second.
    // Studio can merge one out of a selection, and a stack is what makes that
    // selection findable. It follows the title rather than the first filename,
    // which is a counter and a seed: a stack called `image-320` is no easier to
    // pick out of Studio than the twenty loose files would have been.
    await openPanelOverTwo()
    fireEvent.change(screen.getByPlaceholderText(/title each from its own prompt/), {
      target: { value: 'Sister of the Halberd' },
    })
    await sentTags()
    expect(deviantArtSends[0]!.stack).toBe('Sister of the Halberd')
  })

  it('titles every submission from the batch title', async () => {
    await openPanelOverTwo()
    fireEvent.change(screen.getByPlaceholderText(/title each from its own prompt/), {
      target: { value: 'Sister of the Halberd' },
    })
    screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).click()
    await waitFor(() => expect(deviantArtSends).toHaveLength(1))
    const titles = (deviantArtSends[0]!.drafts as Array<{ title: string }>).map((d) => d.title)
    expect(titles).toEqual(['Sister of the Halberd', 'Sister of the Halberd'])
  })

  it('uploads the chosen poster first, whatever order the grid picked', async () => {
    // The upload order *is* the stack order, and the stack order is what a
    // Studio merge turns into image 1, 2, 3. Nothing else in the batch can say
    // "this is the one people will see".
    await openPanelOverTwo()
    const [, second] = screen.getAllByRole('button', { name: 'make poster' })
    // The first row is already the poster, so only the second offers the button.
    fireEvent.click(second ?? screen.getByRole('button', { name: 'make poster' }))
    screen.getByRole('button', { name: 'Upload 2 to Sta.sh' }).click()
    await waitFor(() => expect(deviantArtSends).toHaveLength(1))
    const order = (deviantArtSends[0]!.drafts as Array<{ mediaId: number }>).map((d) => d.mediaId)
    expect(order[0]).toBe(nth(1))
  })

  it('asks for original resolution rather than DeviantArt’s downscaled default', async () => {
    // Their default draws a 2627x3840 upload at 1280 wide, which throws away
    // the reason for uploading a 4K render.
    await openPanelOverTwo()
    await sentTags()
    const shown = (deviantArtSends[0]!.drafts as Array<{ displayResolution: number }>).map(
      (draft) => draft.displayResolution,
    )
    expect(shown).toEqual([0, 0])
  })
})

describe('the AI filter cycle', () => {
  /** The pill, whatever state it is currently labelled with. */
  const pill = () =>
    screen.getByRole('button', { name: /^(AI|AI Unrated|No AI)$/ })

  async function ready() {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    queries.length = 0
  }

  /** The most recent query the grid actually sent to the backend. */
  const sent = () => queries.at(-1) as unknown as Record<string, unknown>

  it('walks off → AI → AI Unrated → No AI → off', async () => {
    await ready()

    pill().click()
    await waitFor(() => expect(sent().tag).toBe('generated'))
    expect(sent().unstarred).toBe(false)
    expect(screen.getByRole('button', { name: 'AI' })).toBeTruthy()

    pill().click()
    await waitFor(() => expect(sent().unstarred).toBe(true))
    expect(sent().tag).toBe('generated')
    expect(screen.getByRole('button', { name: 'AI Unrated' })).toBeTruthy()

    pill().click()
    await waitFor(() => expect(sent().hideTags).toEqual(['generated']))
    expect(sent().tag).toBeNull()
    expect(screen.getByRole('button', { name: 'No AI' })).toBeTruthy()

    pill().click()
    await waitFor(() => expect(sent().hideTags).toEqual([]))
    expect(sent().tag).toBeNull()
    expect(screen.getByRole('button', { name: 'AI' })).toBeTruthy()
  })

  it('never leaves the triage narrowing applied once the pill has moved on', async () => {
    // `unstarred` belongs to the whole query, not to this pill. Leaving it set
    // would silently hide every rated picture with nothing on screen claiming
    // to be doing it.
    await ready()
    pill().click()
    await waitFor(() => expect(sent().tag).toBe('generated'))
    pill().click()
    await waitFor(() => expect(sent().unstarred).toBe(true))

    pill().click()
    await waitFor(() => expect(sent().unstarred).toBe(false))
    pill().click()
    await waitFor(() => expect(sent().unstarred).toBe(false))
  })

  it('drops a 4-star filter rather than asking for the impossible', async () => {
    // Nothing is both unstarred and rated four or better, so the two cannot be
    // on together — the same rule the two star pills already follow.
    await ready()
    screen.getByRole('button', { name: '★ 4+' }).click()
    await waitFor(() => expect(sent().minStars).toBe(4))

    pill().click()
    await waitFor(() => expect(sent().tag).toBe('generated'))
    pill().click()
    await waitFor(() => expect(sent().unstarred).toBe(true))
    expect(sent().minStars).toBeNull()
  })

  it('gives the Docs pill no triage step', async () => {
    // "Documents I have not starred" is not a question anyone has, and a fourth
    // click on every pill to reach the third state is a worse bar for everyone.
    await ready()
    const docs = () => screen.getByRole('button', { name: /^(Docs|No Docs)$/ })

    docs().click()
    await waitFor(() => expect(sent().tag).toBe('document'))
    docs().click()
    await waitFor(() => expect(sent().hideTags).toEqual(['document']))
    expect(sent().unstarred).toBe(false)
  })
})

describe('judging a selection from the grid', () => {
  const nth = (index: number) => LIBRARY_SIZE - index
  const press = (key: string, init: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))

  async function selectThree() {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: 'Select' }).click()
    await screen.findByText('Nothing selected')
    screen.getByTitle(`image-${nth(0)}.png`).click()
    fireEvent.click(screen.getByTitle(`image-${nth(2)}.png`), { shiftKey: true })
    await screen.findByText('3 selected')
  }

  it('rates the whole selection with one call, not one per picture', async () => {
    // The same reasoning as the batch delete: a selection can be hundreds, and
    // that many round trips is slow and impossible to report on sensibly.
    await selectThree()
    press('4')

    await waitFor(() => expect(starBatches).toHaveLength(1))
    expect([...starBatches[0]!.ids].sort((a, b) => b - a)).toEqual([nth(0), nth(1), nth(2)])
    expect(starBatches[0]!.stars).toBe(4)
    expect(starCalls).toHaveLength(0)
  })

  it('clears the whole selection with 0', async () => {
    await selectThree()
    press('0')
    await waitFor(() => expect(starBatches).toHaveLength(1))
    expect(starBatches[0]!.stars).toBeNull()
  })

  it('deletes the selection with Delete, asking the same question the button does', async () => {
    await selectThree()
    press('Delete')

    expect(await screen.findByText('Delete permanently?')).toBeTruthy()
    screen.getByRole('button', { name: 'Delete permanently' }).click()
    await waitFor(() => expect(deleteBatches).toHaveLength(1))
    expect(deleteBatches[0]!.ids).toHaveLength(3)
  })

  it('ignores auto-repeat, so holding Delete cannot answer its own question', async () => {
    await selectThree()
    press('Delete', { repeat: true })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByText('Delete permanently?')).toBeNull()
  })

  it('does nothing without a selection', async () => {
    // These keys belong to the selection. Firing them over a whole library
    // because nothing was picked would be catastrophic for Delete.
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    press('4')
    press('Delete')

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(starBatches).toHaveLength(0)
    expect(screen.queryByText('Delete permanently?')).toBeNull()
  })

  it('leaves a modifier combination alone', async () => {
    // Ctrl-0 resets the browser's zoom; stealing it would be worse than not
    // having the shortcut.
    await selectThree()
    press('0', { ctrlKey: true })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(starBatches).toHaveLength(0)
  })

  it('never takes a digit away from a text field', async () => {
    // The search box is one Tab away, and a listener that eats digits is how
    // "00166" becomes unsearchable.
    await selectThree()
    const search = screen.getByPlaceholderText(/search/i)
    search.focus()
    fireEvent.keyDown(search, { key: '4', bubbles: true })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(starBatches).toHaveLength(0)
  })
})

describe('the prompt panel', () => {
  const open = async (id: number) => {
    render(<App />)
    ;(await screen.findByTitle(`image-${id}.png`)).click()
    await screen.findByRole('group', { name: 'Rating' })
  }

  it('is already open on a picture that carries a prompt', async () => {
    // For a library that is almost entirely generated, the prompt is what the
    // picture is — pressing a key on every file to read it is the wrong way
    // round.
    library[0]!.generation = {
      tool: 'Stable Diffusion',
      prompt: '1girl, silver hair',
      needsSourceImage: false, postprocessed: false, characters: [],
    }
    await open(LIBRARY_SIZE)

    expect(await screen.findByText('1girl, silver hair')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Hide prompt' })).toBeTruthy()
  })

  it('shows nothing at all on a picture that carries none', async () => {
    // The default costs nothing here: no panel, and no button either.
    await open(LIBRARY_SIZE)

    expect(screen.queryByRole('button', { name: 'Hide prompt' })).toBeNull()
    expect(screen.queryByTitle(/Generated with/)).toBeNull()
  })

  it('stays closed once closed, rather than returning on the next picture', async () => {
    // Forcing it open per picture would make the close button useless — one
    // arrow key and it would be back.
    for (const row of library.slice(0, 2)) {
      row.generation = { tool: 'Stable Diffusion', prompt: 'a prompt', needsSourceImage: false, postprocessed: false, characters: [] }
    }
    await open(LIBRARY_SIZE)

    screen.getByRole('button', { name: 'Hide prompt' }).click()
    await screen.findByTitle(/Generated with/)

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByTitle(/Generated with/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Hide prompt' })).toBeNull()
  })
})

describe('the timeline', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000
  /** Monday 2024-07-01 00:00 UTC. */
  const MONDAY = 1_719_792_000_000

  /** Two weeks of history: 3 files in week one, 1 in week two. */
  function twoWeekLibrary() {
    library = [
      { ...makeItem(1), modifiedAt: MONDAY + 1000 },
      { ...makeItem(2), modifiedAt: MONDAY + 2000 },
      { ...makeItem(3), modifiedAt: MONDAY + 3000 },
      { ...makeItem(4), modifiedAt: MONDAY + WEEK + 1000 },
    ]
  }

  async function openTimeline() {
    render(<App />)
    await screen.findByTitle('image-1.png')
    queries.length = 0
    screen.getByRole('button', { name: 'Timeline' }).click()
    // Four bars: one per week with anything in it.
    await waitFor(() =>
      expect(screen.getAllByTitle(/Click to show only this week/)).toHaveLength(2),
    )
  }

  const sent = () => queries.at(-1) as unknown as Record<string, unknown>

  it('shows a bar per week, sized by how much the week holds', async () => {
    twoWeekLibrary()
    await openTimeline()

    const bars = screen.getAllByTitle(/Click to show only this week/)
    expect(bars[0]!.title).toContain('3 items')
    expect(bars[1]!.title).toContain('1 item')
  })

  it('narrows the grid to a week when its bar is clicked', async () => {
    twoWeekLibrary()
    await openTimeline()

    screen.getAllByTitle(/Click to show only this week/)[0]!.click()
    await waitFor(() => expect(sent().modifiedAfter).toBe(MONDAY))
    expect(sent().modifiedBefore).toBe(MONDAY + WEEK)
  })

  it('clears the narrowing when the selection is cleared', async () => {
    twoWeekLibrary()
    await openTimeline()

    screen.getAllByTitle(/Click to show only this week/)[0]!.click()
    await waitFor(() => expect(sent().modifiedAfter).toBe(MONDAY))
    ;(await screen.findByRole('button', { name: 'clear' })).click()
    await waitFor(() => expect(sent().modifiedAfter).toBeNull())
    expect(sent().modifiedBefore).toBeNull()
  })

  it('clears the narrowing when the panel itself is closed', async () => {
    // A range with no bars on screen would be an invisible filter — the grid
    // quietly small and nothing saying why.
    twoWeekLibrary()
    await openTimeline()

    screen.getAllByTitle(/Click to show only this week/)[0]!.click()
    await waitFor(() => expect(sent().modifiedAfter).toBe(MONDAY))

    screen.getByRole('button', { name: 'Timeline' }).click()
    await waitFor(() => expect(sent().modifiedAfter).toBeNull())
    expect(screen.queryByTitle(/Click to show only this week/)).toBeNull()
  })

  it('offers both resize handles once a selection exists', async () => {
    twoWeekLibrary()
    await openTimeline()
    screen.getAllByTitle(/Click to show only this week/)[0]!.click()

    expect(
      await screen.findByRole('button', { name: 'Drag to move the start of the selection' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Drag to move the end of the selection' }),
    ).toBeTruthy()
  })
})

describe('what the timeline sends and how it fails', () => {
  const MONDAY = 1_719_792_000_000

  it('always sends the complete wire shape, with the range neutralised', async () => {
    // Rust rejects a struct with fields missing — the first version of the
    // panel deleted `offset` from the query and every fetch failed, dressed as
    // an empty library. The full shape with the range nulled is the contract.
    library = [{ ...makeItem(1), modifiedAt: MONDAY + 1000 }]
    render(<App />)
    await screen.findByTitle('image-1.png')
    screen.getByRole('button', { name: 'Timeline' }).click()
    await waitFor(() => expect(timelineQueries.length).toBeGreaterThan(0))

    const sent = timelineQueries[0]!
    for (const field of ['offset', 'limit', 'sort', 'search', 'folderId', 'hideTags']) {
      expect(sent, `timeline query is missing "${field}"`).toHaveProperty(field)
    }
    expect(sent.modifiedAfter).toBeNull()
    expect(sent.modifiedBefore).toBeNull()
    expect(sent.offset).toBe(0)
  })

  it('wears its own message when the fetch fails, not the empty state', async () => {
    // "Nothing here has a usable date" over a working library sends someone
    // auditing their files' mtimes for a bug that lives in the panel.
    timelineFailure = 'invalid args `query`'
    library = [{ ...makeItem(1), modifiedAt: MONDAY + 1000 }]
    render(<App />)
    await screen.findByTitle('image-1.png')
    screen.getByRole('button', { name: 'Timeline' }).click()

    expect(await screen.findByText(/The timeline could not be read/)).toBeTruthy()
    expect(screen.queryByText(/usable date/)).toBeNull()
  })
})

describe('implausible dates on the timeline', () => {
  const MONDAY = 1_719_792_000_000
  /** ~The DOS epoch, which zip extractors stamp on files. */
  const DOS_1980 = 315_446_400_000

  it('keeps junk mtimes off the axis, and says so', async () => {
    // One 1980 file against a real library must not stretch the axis across
    // five decades and flatten everything else into sub-pixel slivers. The
    // real cluster has to be genuinely dominant — the trim is share-based, so
    // one junk file in a library of three is a third of it and rightly stays.
    library = [
      { ...makeItem(1), modifiedAt: DOS_1980 + 1000 },
      ...Array.from({ length: 200 }, (_, index) => ({
        ...makeItem(index + 2),
        modifiedAt: MONDAY + index * 1000,
      })),
    ]
    render(<App />)
    await screen.findByTitle('image-1.png')
    screen.getByRole('button', { name: 'Timeline' }).click()

    // The axis starts and ends at the real library — both header labels.
    await waitFor(() => expect(screen.getAllByText('Jul 2024')).toHaveLength(2))
    expect(screen.queryByText(/19(79|80)/)).toBeNull()
    // …and the trim is announced rather than silent — a hidden file that
    // simply vanished would read as the library being smaller than the folder.
    expect(screen.getByText(/1 with implausible dates not drawn/)).toBeTruthy()
  })
})

describe('moving the timeline selection', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000
  const MONDAY = 1_719_792_000_000

  /** Four weeks of files, so the strip has four bars to slide across. */
  async function openWithSelection() {
    library = Array.from({ length: 4 }, (_, week) => ({
      ...makeItem(week + 1),
      modifiedAt: MONDAY + week * WEEK + 1000,
    }))
    render(<App />)
    await screen.findByTitle('image-1.png')
    // jsdom has no layout, so the strip measures 0×0 and every pixel maps to
    // bar 0. Real geometry is what makes this test mean anything.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 64, width: 400, height: 64,
      toJSON: () => ({}),
    } as DOMRect)
    screen.getByRole('button', { name: 'Timeline' }).click()
    const bars = await screen.findAllByTitle(/Click to show only/)
    bars[0]!.click()
    await screen.findByRole('button', { name: 'Drag to move the selection' })
    queries.length = 0
  }

  const sent = () => queries.at(-1) as unknown as Record<string, unknown>

  /**
   * A pointer event with real coordinates. jsdom has no PointerEvent, and
   * testing-library's fallback carries no clientX — which is exactly the
   * coordinate-less event the NaN guard in `barAt` exists for, but not what a
   * drag test wants to be exercising.
   */
  const point = (target: Element, type: string, clientX: number) =>
    fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }))

  it('slides the whole range where the body is dragged', async () => {
    await openWithSelection()
    const body = screen.getByRole('button', { name: 'Drag to move the selection' })

    // Grab in bar 0 (x=50 of 400 across 4 bars) and carry to bar 2 (x=250).
    point(body, 'pointerdown', 50)
    point(body, 'pointermove', 250)
    point(body, 'pointerup', 250)

    await waitFor(() => expect(sent().modifiedAfter).toBe(MONDAY + 2 * WEEK))
    expect(sent().modifiedBefore).toBe(MONDAY + 3 * WEEK)
  })

  it('a press that never crossed a bar is a click on the bar underneath', async () => {
    // The body covers the bars inside the selection; without this fallback an
    // active selection makes those bars unclickable, which reads as broken.
    await openWithSelection()
    // Slide to bar 1 first, so the click's effect is distinguishable from the
    // selection that was already there.
    const body = screen.getByRole('button', { name: 'Drag to move the selection' })
    point(body, 'pointerdown', 50)
    point(body, 'pointermove', 150)
    point(body, 'pointerup', 150)
    await waitFor(() => expect(sent().modifiedAfter).toBe(MONDAY + WEEK))
    queries.length = 0

    point(body, 'pointerdown', 150)
    point(body, 'pointerup', 150)
    await waitFor(() => expect(sent().modifiedBefore).toBe(MONDAY + 2 * WEEK))
    expect(sent().modifiedAfter).toBe(MONDAY + WEEK)
  })

  it('a cancelled gesture selects nothing', async () => {
    await openWithSelection()
    const body = screen.getByRole('button', { name: 'Drag to move the selection' })
    const strip = body.parentElement!

    point(body, 'pointerdown', 50)
    point(strip, 'pointercancel', 50)

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(queries).toHaveLength(0)
  })
})

describe('the character leaderboard', () => {
  it('ranks names in the sidebar and clicking one becomes the search', async () => {
    topCharactersState = [
      { name: 'aqua (konosuba)', count: 4182 },
      { name: 'tsukishiro yanagi (zenless zone zero)', count: 96 },
    ]
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    // Ranked, biggest first, counts visible.
    const aqua = await screen.findByTitle('Show only aqua (konosuba)')
    // Formatted the same way the component formats it, whatever this
    // machine's locale does to thousands separators.
    expect(aqua.textContent).toContain((4182).toLocaleString())
    queries.length = 0

    aqua.click()
    // The click IS a search: the term reaches the backend and the box shows
    // it, so the filter is visible and clearable like any typed search.
    await waitFor(() =>
      expect((queries.at(-1) as { search?: string } | undefined)?.search).toBe('aqua (konosuba)'),
    )
    expect(
      (screen.getByPlaceholderText(/search/i) as HTMLInputElement).value,
    ).toBe('aqua (konosuba)')
  })

  it('shows nothing when the library has no detected characters', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    expect(screen.queryByText('Characters')).toBeNull()
  })
})

describe('the Prompt filter', () => {
  it('cycles off → with prompt → without → off', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    queries.length = 0
    const sent = () => queries.at(-1) as { hasPrompt?: boolean | null } | undefined

    const pill = () => screen.getByRole('button', { name: /^(Prompt|No Prompt)$/ })
    pill().click()
    await waitFor(() => expect(sent()?.hasPrompt).toBe(true))

    pill().click()
    await waitFor(() => expect(sent()?.hasPrompt).toBe(false))
    expect(screen.getByRole('button', { name: 'No Prompt' })).toBeTruthy()

    pill().click()
    await waitFor(() => expect(sent()?.hasPrompt).toBeNull())
  })
})

describe('the More filters panel', () => {
  const sent = () =>
    queries.at(-1) as
      | { greyscale?: boolean | null; animated?: boolean | null; label?: string | null; minLongestEdge?: number | null }
      | undefined

  async function openMore() {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    screen.getByRole('button', { name: /^More/ }).click()
  }

  it('stays out of the way until it is asked for', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    // The bar is already crowded; these are the filters you reach for
    // occasionally, not the ones you steer with.
    expect(screen.queryByRole('button', { name: 'B&W' })).toBeNull()

    screen.getByRole('button', { name: /^More/ }).click()
    expect(await screen.findByRole('button', { name: 'B&W' })).toBeTruthy()
  })

  it('asks the index for black and white', async () => {
    await openMore()
    queries.length = 0
    screen.getByRole('button', { name: 'B&W' }).click()
    await waitFor(() => expect(sent()?.greyscale).toBe(true))

    screen.getByRole('button', { name: 'B&W' }).click()
    await waitFor(() => expect(sent()?.greyscale).toBeNull())
  })

  it('sends both halves of "stills only", because it is two questions', async () => {
    // Animation is not a kind — a GIF and a PNG are both images — so excluding
    // videos and excluding GIFs are separate predicates that have to compose.
    await openMore()
    queries.length = 0
    screen.getByRole('button', { name: 'Stills only' }).click()

    await waitFor(() => expect(sent()?.animated).toBe(false))
    expect((queries.at(-1) as { kind?: string | null }).kind).toBe('image')
  })

  it('filters on a label the verdict could never have named', async () => {
    // FACE_FEMALE carries no rating weight, so it can never be a topLabel —
    // the whole reason the labels table exists.
    await openMore()
    queries.length = 0
    fireEvent.change(screen.getByLabelText('Found'), { target: { value: 'FACE_FEMALE' } })

    await waitFor(() => expect(sent()?.label).toBe('FACE_FEMALE'))
  })

  it('counts what is on, so a collapsed panel cannot secretly empty the grid', async () => {
    await openMore()
    screen.getByRole('button', { name: 'B&W' }).click()
    await screen.findByRole('button', { name: 'More · 1' })

    screen.getByRole('button', { name: 'More · 1' }).click()
    // Collapsed again, and still saying that something is narrowing the grid.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'B&W' })).toBeNull())
    expect(screen.getByRole('button', { name: 'More · 1' })).toBeTruthy()
  })

  it('clears the whole panel in one go', async () => {
    await openMore()
    screen.getByRole('button', { name: 'B&W' }).click()
    screen.getByRole('button', { name: 'GIFs' }).click()
    const clear = await screen.findByText('clear these')
    queries.length = 0

    clear.click()
    await waitFor(() => expect(sent()?.greyscale).toBeNull())
    expect(sent()?.animated).toBeNull()
  })
})

describe('img2img', () => {
  it('the pill cycles off → only → exclude → off', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    queries.length = 0
    const sent = () => queries.at(-1) as { img2img?: boolean | null } | undefined
    const pill = () => screen.getByRole('button', { name: /^(img2img|No img2img)$/ })

    pill().click()
    await waitFor(() => expect(sent()?.img2img).toBe(true))
    pill().click()
    await waitFor(() => expect(sent()?.img2img).toBe(false))
    expect(screen.getByRole('button', { name: 'No img2img' })).toBeTruthy()
    pill().click()
    await waitFor(() => expect(sent()?.img2img).toBeNull())
  })
})


describe('the leaderboard follows the filters', () => {
  it('re-asks with the grid query when a filter changes', async () => {
    topCharactersState = [{ name: 'aqua (konosuba)', count: 3 }]
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    topCharacterQueries.length = 0

    screen.getByRole('button', { name: 'Videos' }).click()
    await waitFor(() =>
      expect(topCharacterQueries.some((query) => query.kind === 'video')).toBe(true),
    )
    // Thirty, not ten: the sidebar sizes the list to the window, and the
    // fetch has to carry enough rows for the tall case.
    expect(topCharacterQueries.every((query) => query.askedLimit === 30)).toBe(true)
  })

  it('never narrows itself by the search term', async () => {
    // Clicking a character IS a search. A leaderboard narrowed by it would
    // collapse to that one name, and the list that navigated you somewhere
    // could never take you anywhere else.
    topCharactersState = [
      { name: 'aqua (konosuba)', count: 3 },
      { name: 'murasaki shion', count: 2 },
    ]
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    ;(await screen.findByTitle('Show only aqua (konosuba)')).click()

    await waitFor(() =>
      expect((queries.at(-1) as { search?: string } | undefined)?.search).toBe('aqua (konosuba)'),
    )
    // Every leaderboard fetch, including the one this click caused, asked
    // with the search stripped.
    expect(topCharacterQueries.length).toBeGreaterThan(0)
    for (const asked of topCharacterQueries) expect(asked.search).toBe('')
  })
})

describe('timeline and search together', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000
  const MONDAY = 1_719_792_000_000

  it('a dragged range survives searching, and clearing the search', async () => {
    // The reported sequence: select a timerange, then search — the results
    // must narrow to BOTH. Then delete the term — the range must still be
    // there, selection and all. The first version wiped the selection on
    // every filter change, both directions.
    library = Array.from({ length: 4 }, (_, week) => ({
      ...makeItem(week + 1),
      modifiedAt: MONDAY + week * WEEK + 1000,
    }))
    render(<App />)
    await screen.findByTitle('image-1.png')
    screen.getByRole('button', { name: 'Timeline' }).click()
    const bars = await screen.findAllByTitle(/Click to show only/)
    bars[0]!.click()
    await waitFor(() =>
      expect((queries.at(-1) as { modifiedAfter?: number | null }).modifiedAfter).toBe(MONDAY),
    )

    const search = screen.getByPlaceholderText(/search/i)
    fireEvent.change(search, { target: { value: 'aqua (konosuba)' } })
    await waitFor(() => {
      const sent = queries.at(-1) as { search?: string; modifiedAfter?: number | null }
      expect(sent.search).toBe('aqua (konosuba)')
      // The range rides along — this is the "results didn't update
      // accordingly" half of the bug.
      expect(sent.modifiedAfter).toBe(MONDAY)
    })

    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => {
      const sent = queries.at(-1) as { search?: string; modifiedAfter?: number | null }
      expect(sent.search).toBe('')
      // And clearing the term must not reset the timeline — the other half.
      expect(sent.modifiedAfter).toBe(MONDAY)
    })
    // The selection is still drawn: handles present, clear still offered.
    expect(
      screen.getByRole('button', { name: 'Drag to move the selection' }),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'clear' })).toBeTruthy()
  })
})

describe('the folder-path search toggle', () => {
  it('aims the term already typed, without disturbing it', async () => {
    // The whole promise of a mode rather than a second box: type once, and if
    // the answer is not in the names, click once to ask the folders the same
    // question. A toggle that cleared the field — or that only took effect on
    // the next keystroke — would be no faster than a separate input.
    library = [makeItem(1)]
    render(<App />)
    await screen.findByTitle('image-1.png')

    const search = screen.getByPlaceholderText(/search/i)
    fireEvent.change(search, { target: { value: 'moona' } })
    await waitFor(() => {
      const sent = queries.at(-1) as { search?: string; searchPaths?: boolean }
      expect(sent.search).toBe('moona')
      expect(sent.searchPaths).toBe(false)
    })

    screen.getByRole('button', { name: 'Search folder paths' }).click()
    await waitFor(() => {
      const sent = queries.at(-1) as { search?: string; searchPaths?: boolean }
      expect(sent.searchPaths).toBe(true)
      expect(sent.search, 'the term must survive the mode change').toBe('moona')
    })
    expect((screen.getByPlaceholderText(/search/i) as HTMLInputElement).value).toBe('moona')

    // And back, because a mode you cannot leave is a trap — the grid would
    // stay narrowed to nothing with no visible reason why.
    screen.getByRole('button', { name: 'Search folder paths' }).click()
    await waitFor(() =>
      expect((queries.at(-1) as { searchPaths?: boolean }).searchPaths).toBe(false),
    )
  })

  it('says which mode it is in, in the field and on the button', async () => {
    // The one thing that makes an unexpected empty grid explicable rather than
    // a bug report: a search that found nothing has to say what it searched.
    library = [makeItem(1)]
    render(<App />)
    await screen.findByTitle('image-1.png')

    const toggle = screen.getByRole('button', { name: 'Search folder paths' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByPlaceholderText(/filenames and prompts/i)).toBeTruthy()

    toggle.click()
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByPlaceholderText(/folder paths/i)).toBeTruthy()
  })
})

describe('the timeline axis under search', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000
  const MONDAY = 1_719_792_000_000

  it('asks for the unsearched span alongside the searched counts', async () => {
    // The axis belongs to the library, the heights to the search: one fetch
    // with the term stripped (start and end of the strip hold still), one
    // with it applied (the bars tell the matches' story).
    library = Array.from({ length: 4 }, (_, week) => ({
      ...makeItem(week + 1),
      modifiedAt: MONDAY + week * WEEK + 1000,
    }))
    render(<App />)
    await screen.findByTitle('image-1.png')
    screen.getByRole('button', { name: 'Timeline' }).click()
    await screen.findAllByTitle(/Click to show only/)
    timelineQueries.length = 0

    fireEvent.change(screen.getByPlaceholderText(/search/i), {
      target: { value: 'murasaki shion' },
    })

    await waitFor(() => {
      const searches = timelineQueries.map((asked) => (asked as { search?: string }).search)
      expect(searches).toContain('')
      expect(searches).toContain('murasaki shion')
    })
    // The strip is still there and still spans the full library — four bars,
    // not just the weeks the term matches.
    expect(screen.getAllByTitle(/Click to show only/)).toHaveLength(4)
  })
})

describe('the Extras filter', () => {
  it('cycles off → only → exclude → off', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)
    queries.length = 0
    const sent = () => queries.at(-1) as { extras?: boolean | null } | undefined
    const pill = () => screen.getByRole('button', { name: /^(Extras|No Extras)$/ })

    pill().click()
    await waitFor(() => expect(sent()?.extras).toBe(true))
    pill().click()
    await waitFor(() => expect(sent()?.extras).toBe(false))
    expect(screen.getByRole('button', { name: 'No Extras' })).toBeTruthy()
    pill().click()
    await waitFor(() => expect(sent()?.extras).toBeNull())
  })
})

describe('remote mode', () => {
  it('says which machine the window is showing, and opens the panel', async () => {
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    // Local by default, and the button is there in that state — one that only
    // appeared once connected would be one you could not connect with.
    const button = await screen.findByRole('button', { name: 'Local' })
    button.click()

    expect(await screen.findByRole('dialog', { name: 'Remote mode' })).toBeTruthy()
    // Both halves are in the one panel: the machine you type an address into,
    // and the machine you switch sharing on at.
    expect(screen.getByLabelText('Address')).toBeTruthy()
    expect(screen.getByLabelText('Sharing passphrase')).toBeTruthy()
  })

  it('names the peer in the status bar while a session is live', async () => {
    remoteState = {
      connected: true,
      address: '192.168.1.42:7870',
      host: 'DESKTOP-VAULT',
      folders: 3,
      items: 66412,
      lastAddress: '192.168.1.42:7870',
      hasPassphrase: true,
    }
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    // The machine, not the number, because that is what a person recognises.
    const badge = await screen.findByRole('button', { name: 'Remote · DESKTOP-VAULT' })
    // Delete means "delete over there" from here, so the reminder has to be
    // legible at a glance rather than a word among nine others.
    expect(badge.closest('footer')?.className).toContain('indigo')

    badge.click()
    // The way back is where the way in was.
    expect(await screen.findByRole('button', { name: 'Back to this machine' })).toBeTruthy()
    // And there is no address field to type into while one is already open.
    expect(screen.queryByLabelText('Address')).toBeNull()
  })

  it('shows that this library is being shared, and where', async () => {
    shareState = {
      sharing: true,
      port: 7870,
      addresses: ['192.168.1.7:7870'],
      hasPassphrase: true,
    }
    render(<App />)
    await screen.findByTitle(`image-${LIBRARY_SIZE}.png`)

    const button = await screen.findByRole('button', { name: 'Sharing' })
    button.click()
    // The address to type on the other machine, verbatim.
    expect(await screen.findByText('192.168.1.7:7870')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Stop sharing' })).toBeTruthy()
  })
})

describe('leaving folder-path search', () => {
  it('keeps answering filter changes after the term is cleared and the mode turned off', async () => {
    // Reported: search in folder mode, delete the term, untoggle the folder
    // button — the grid stops updating, and every filter change after it does
    // nothing. This walks that exact sequence and asserts the backend is still
    // being asked, which is the half a fake backend can actually settle.
    library = [makeItem(1)]
    render(<App />)
    await screen.findByTitle('image-1.png')

    const search = screen.getByPlaceholderText(/search/i)
    screen.getByRole('button', { name: 'Search folder paths' }).click()
    fireEvent.change(search, { target: { value: 'moona' } })
    await waitFor(() => {
      const sent = queries.at(-1) as { search?: string; searchPaths?: boolean }
      expect(sent.search).toBe('moona')
      expect(sent.searchPaths).toBe(true)
    })

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: '' } })
    await waitFor(() => expect((queries.at(-1) as { search?: string }).search).toBe(''))

    screen.getByRole('button', { name: 'Search folder paths' }).click()
    await waitFor(() =>
      expect((queries.at(-1) as { searchPaths?: boolean }).searchPaths).toBe(false),
    )

    // And now the part that is reported broken: an ordinary filter afterwards.
    const before = queries.length
    screen.getByRole('button', { name: 'Videos' }).click()
    await waitFor(() => expect(queries.length).toBeGreaterThan(before))
    expect((queries.at(-1) as { kind?: string | null }).kind).toBe('video')
  })
})
