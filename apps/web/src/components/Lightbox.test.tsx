import type { MediaItem } from '@luma/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogs } from '#/lib/dialogs.ts'
import { resetPreloads } from '#/lib/preload.ts'
import { DialogHost } from './DialogHost.tsx'
import { Lightbox } from './Lightbox.tsx'

/**
 * These pin what makes stepping through the lightbox feel instant. All three
 * are invisible when they break — the app still shows the right picture, just
 * later — which is exactly the kind of regression that survives review.
 *
 * 1. Something is on screen **before** the original is asked for, and it is the
 *    thumbnail, painted into the rectangle the original will land in.
 * 2. The original is not asked for at all until the row has been dwelt on, so
 *    sweeping past a row costs nothing.
 * 3. The neighbours' thumbnails are fetched while the current row is up.
 */

const STAGE = { width: 1000, height: 800 }
const THUMB = '/thumbs/ab/cd/holiday.jpg'

function makeItem(id: number, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    folderId: 1,
    path: `/media/holiday-${id}.jpg`,
    name: `holiday-${id}.jpg`,
    kind: 'image',
    width: 4000,
    height: 3000,
    sizeBytes: 2_400_000,
    modifiedAt: 1_700_000_000_000,
    addedAt: 1_700_000_000_000,
    thumbPath: `${THUMB}-${id}`,
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
    ...overrides,
  }
}

const url = (path: string) => `luma://localhost/?path=${encodeURIComponent(path)}`

/** Rows the fake backend will eventually answer with, and how slowly. */
let backend: MediaItem[] = []
let answer: (() => void) | null = null

vi.mock('#/lib/native.ts', () => ({
  fileUrl: (path: string) => `luma://localhost/?path=${encodeURIComponent(path)}`,
  // Deliberately never resolved by default. Every assertion below is about what
  // is on screen *before* the backend answers, so a test that only passes once
  // it has is testing the wrong thing.
  mediaById: (id: number) =>
    new Promise<MediaItem | null>((resolve) => {
      answer = () => resolve(backend.find((row) => row.id === id) ?? null)
    }),
  mediaByPath: (path: string) =>
    Promise.resolve(backend.find((row) => row.path === path) ?? null),
  mediaFrames: () => Promise.resolve([]),
  setStars: () => Promise.resolve(),
  deleteItem: () => Promise.resolve(),
  revealInFileManager: () => Promise.resolve(),
  generationParameters: () => Promise.resolve(null),
  forgeSelectCheckpoint: () => Promise.resolve(null),
  forgeUrl: () => Promise.resolve('http://127.0.0.1:7860'),
  openExternal: () => Promise.resolve(),
}))

/** Every URL something asked the browser to fetch ahead of time. */
const warmed: string[] = []

class FakeImage {
  #src = ''
  addEventListener() {}
  removeEventListener() {}
  set src(value: string) {
    this.#src = value
    warmed.push(value)
  }
  get src() {
    return this.#src
  }
}

beforeEach(() => {
  backend = []
  answer = null
  warmed.length = 0
  vi.stubGlobal('Image', FakeImage)

  // jsdom implements no part of the pointer-events API. Testing Library falls
  // back to a plain `Event` when the constructor is missing, which silently
  // drops `clientX`, `button` and `pointerId` — so a pan test would fire events
  // carrying none of the numbers it is about and pass or fail for the wrong
  // reason. `MouseEvent` *is* implemented and already carries all of those.
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 0
      }
    },
  )
  // Not restored by `unstubAllGlobals`, but assigning a no-op to a prototype
  // that has no such method cannot change behaviour for anything else.
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}

  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: STAGE } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  resetDialogs()
  cleanup()
  // The in-flight table is module state and outlives a render, so without this
  // every case after the first would find its warming already "done".
  resetPreloads()
  vi.unstubAllGlobals()
})

function renderLightbox(props: Partial<React.ComponentProps<typeof Lightbox>> = {}) {
  const item = props.seed ?? makeItem(1)
  return render(
    <>
    <Lightbox
      mediaId={item.id}
      seed={item}
      preload={[]}
      onClose={() => {}}
      onStep={() => {}}
      showBoxes={false}
      onToggleBoxes={() => {}}
      onExcludeFolder={() => {}}
      showGeneration={false}
      onToggleGeneration={() => {}}
      onDeleted={() => {}}
      onOpenId={() => {}}
      onToggleSelect={() => {}}
      {...props}
    />
    <DialogHost />
    </>,
  )
}

/** The element carrying the thumbnail. There is only ever one. */
function poster(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('div')].find((node) => node.style.backgroundImage)
}

describe('while the original is still on its way', () => {
  it('paints the thumbnail as a background, in the box the original will fill', () => {
    renderLightbox({ seed: makeItem(1) })

    const frame = poster()
    expect(frame?.style.backgroundImage).toBe(`url("${url(`${THUMB}-1`)}")`)
    // 4000x3000 fitted into the 1000x800 stage. The original lands in exactly
    // this rectangle, which is what makes the swap invisible.
    expect(frame?.style.width).toBe('1000px')
    expect(frame?.style.height).toBe('750px')
  })

  it('mounts no image at all, rather than one with no source', () => {
    // An <img> with an empty src is a broken-image icon sitting in the middle
    // of the picture for the whole wait.
    renderLightbox({ seed: makeItem(1) })
    expect(document.querySelector('img')).toBeNull()
  })

  it('draws from the grid’s copy without waiting for the backend', () => {
    // `mediaById` is left unresolved for the whole case. Before the seed prop
    // existed this rendered nothing at all until it answered, so every step
    // blanked the window for a round-trip.
    renderLightbox({ seed: makeItem(1) })
    expect(answer).not.toBeNull()
    expect(screen.getByText('holiday-1.jpg')).toBeTruthy()
    expect(poster()).toBeTruthy()
  })

  it('shows the thumbnail as a video’s poster and opens no stream yet', () => {
    renderLightbox({ seed: makeItem(1, { kind: 'video', durationSec: 12 }) })

    const video = document.querySelector('video')
    expect(video?.getAttribute('poster')).toBe(url(`${THUMB}-1`))
    // Opening a stream per row swept past is the most expensive thing an arrow
    // key can do here.
    expect(video?.getAttribute('src')).toBeNull()
  })
})

describe('the dwell before the original is fetched', () => {
  // Driven by the clock rather than by waiting, so these pin the delay itself.
  // Asserting only that nothing is mounted synchronously would pass against a
  // zero-length delay, which is the regression worth catching.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function step(id: number) {
    return (
      <Lightbox
        mediaId={id}
        seed={makeItem(id)}
        preload={[]}
        onClose={() => {}}
        onStep={() => {}}
        showBoxes={false}
        onToggleBoxes={() => {}}
        onExcludeFolder={() => {}}
        showGeneration={false}
        onToggleGeneration={() => {}}
        onDeleted={() => {}}
      onOpenId={() => {}}
      onToggleSelect={() => {}}
      />
    )
  }

  it('asks for nothing until the row has been held for the full delay', () => {
    renderLightbox({ seed: makeItem(1) })

    expect(document.querySelector('img')).toBeNull()
    act(() => void vi.advanceTimersByTime(149))
    expect(document.querySelector('img')).toBeNull()

    act(() => void vi.advanceTimersByTime(1))
    const image = document.querySelector('img')
    expect(image?.getAttribute('src')).toBe(url('/media/holiday-1.jpg'))
    expect(image?.getAttribute('decoding')).toBe('async')
    // The poster stays underneath rather than being torn down, so there is no
    // empty frame between the two.
    expect(poster()?.style.backgroundImage).toBe(`url("${url(`${THUMB}-1`)}")`)
  })

  it('never asks for a row that was stepped past mid-dwell', () => {
    const { rerender } = render(step(1))

    // Stepped away with 50ms still to run. This is the case the delay exists
    // for: holding an arrow key must not queue a multi-megabyte read per row.
    act(() => void vi.advanceTimersByTime(100))
    expect(document.querySelector('img')).toBeNull()
    rerender(step(2))

    // The new row is already on screen, from the grid's copy.
    expect(poster()?.style.backgroundImage).toBe(`url("${url(`${THUMB}-2`)}")`)

    // Row 1's timer would have fired here had it not been cleared, and the
    // clock is now well past its deadline.
    act(() => void vi.advanceTimersByTime(100))
    expect(document.querySelector('img')).toBeNull()

    act(() => void vi.advanceTimersByTime(50))
    // Only ever row 2's original. Row 1's was never asked for.
    expect(document.querySelectorAll('img')).toHaveLength(1)
    expect(document.querySelector('img')?.getAttribute('src')).toBe(url('/media/holiday-2.jpg'))
  })
})

describe('the resolution readout', () => {
  function footer(): HTMLElement {
    const found = document.querySelector<HTMLElement>('footer')
    if (!found) throw new Error('no footer')
    return found
  }

  it('shows the file’s own resolution, not what is on screen', () => {
    renderLightbox({ seed: makeItem(1) })
    // The picture is drawn at a quarter of this in the 1000x800 stage, and at
    // 8x that when zoomed. Neither is what the file is.
    expect(footer().textContent).toContain('4000×3000')
  })

  it('keeps saying the same thing while zoomed', () => {
    renderLightbox({ seed: makeItem(1) })
    fireEvent.wheel(document.querySelector('.overflow-hidden')!, {
      deltaY: -100,
      clientX: 500,
      clientY: 400,
      altKey: true,
    })
    expect(footer().textContent).toContain('4000×3000')
  })

  it('says nothing rather than 0×0 before the row has been measured', () => {
    // Mid-scan a row has no dimensions yet. Zero is a number that looks like an
    // answer, which is worse than visibly not having one.
    renderLightbox({ seed: makeItem(1, { width: 0, height: 0 }) })
    expect(footer().textContent).toContain('—')
    expect(footer().textContent).not.toContain('0×0')
  })
})

describe('the upscaled-variant label', () => {
  it('says so, and only on a variant', () => {
    // The grid shows the variant in place of what it was made from, so without
    // this nothing on screen says the picture is not the file that was
    // generated.
    renderLightbox({ seed: makeItem(1) })
    expect(screen.queryByText('4K upscaled')).toBeNull()

    cleanup()
    renderLightbox({ seed: makeItem(1, { upscaledFrom: '/media/holiday-1.png' }) })
    expect(screen.getByText('4K upscaled')).toBeTruthy()
  })

  it('opens the original, which is in no list', () => {
    const onOpenId = vi.fn()
    backend = [makeItem(77, { path: '/media/holiday-1.png' })]
    renderLightbox({
      seed: makeItem(1, { upscaledFrom: '/media/holiday-1.png' }),
      onOpenId,
    })

    fireEvent.click(screen.getByText('4K upscaled'))

    return waitFor(() => expect(onOpenId).toHaveBeenCalledWith(77))
  })

  it('reads "Original" on the other half, and goes back', async () => {
    // One control that flips. The pair is one picture at two resolutions and
    // the question in front of either is the same — show me the other one — so
    // the label names what you would get rather than what you are looking at.
    const onOpenId = vi.fn()
    backend = [makeItem(88, { path: '/media/holiday-1_upscaled_4k.jpg' })]
    renderLightbox({
      seed: makeItem(1, { upscaledTo: '/media/holiday-1_upscaled_4k.jpg' }),
      onOpenId,
    })

    expect(screen.queryByText('4K upscaled')).toBeNull()
    fireEvent.click(screen.getByText('Original'))

    return waitFor(() => expect(onOpenId).toHaveBeenCalledWith(88))
  })

  it('says the original is gone rather than doing nothing', async () => {
    // A variant outlives its original whenever the source is deleted or its
    // folder stops being watched. A button that silently does nothing there
    // reads as broken.
    const onOpenId = vi.fn()
    backend = []
    renderLightbox({
      seed: makeItem(1, { upscaledFrom: '/media/gone.png' }),
      onOpenId,
    })

    fireEvent.click(screen.getByText('4K upscaled'))

    expect(await screen.findByText('That original is not in the library')).toBeTruthy()
    expect(onOpenId).not.toHaveBeenCalled()
  })
})

describe('zooming and panning', () => {
  // 4000x3000 in the 1000x800 stage fits at 0.25, so the picture sits at
  // x 0-1000, y 25-775 — the strips above and below it are the surround.
  const FITTED = '1000px'
  const ORIGINAL = '4000px'

  /** The clipping viewport, which is what the wheel listener is attached to. */
  function stage(): HTMLElement {
    const found = document.querySelector<HTMLElement>('.overflow-hidden')
    if (!found) throw new Error('no stage')
    return found
  }

  // Wrapped, unlike `fireEvent`, which Testing Library wraps for you. A raw
  // dispatch leaves the state update unflushed, so the assertion after it reads
  // the previous render and the case passes or fails for the wrong reason.
  function press(key: string) {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }

  function pointer(type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number) {
    fireEvent[type](stage().firstElementChild ?? stage(), {
      pointerId: 1,
      button: 0,
      clientX: x,
      clientY: y,
    })
  }

  /** A click is a press and release that went nowhere. */
  function click(x: number, y: number) {
    pointer('pointerDown', x, y)
    pointer('pointerUp', x, y)
  }

  it('shows the picture at its original size when clicked', () => {
    renderLightbox({ seed: makeItem(1) })
    expect(poster()?.style.width).toBe(FITTED)

    click(500, 400)

    // One image pixel per CSS pixel — which is what makes this worth doing at
    // all, since a fitted 4000px picture is a quarter of its own detail.
    expect(poster()?.style.width).toBe(ORIGINAL)
    expect(poster()?.style.height).toBe('3000px')
  })

  it('zooms about the point clicked rather than the centre', () => {
    // Clicking a detail should land on that detail. Centring instead would put
    // you somewhere else entirely on a picture this size.
    renderLightbox({ seed: makeItem(1) })
    click(200, 200)
    const left = poster()?.style.left

    press('Escape')
    click(800, 700)

    expect(poster()?.style.left).not.toBe(left)
  })

  it('still closes on a click in the surround beside the picture', () => {
    // Fitting letterboxes, so most of the viewport is not the picture. That
    // click has always closed the lightbox and has to keep doing so.
    const onClose = vi.fn()
    renderLightbox({ seed: makeItem(1), onClose })

    click(500, 10)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(poster()?.style.width).toBe(FITTED)
  })

  it('pans instead of toggling when the pointer actually moves', () => {
    renderLightbox({ seed: makeItem(1) })
    click(500, 400)
    const left = Number.parseFloat(poster()?.style.left ?? '0')

    pointer('pointerDown', 600, 500)
    pointer('pointerMove', 650, 530)
    pointer('pointerUp', 650, 530)

    // Moved by the drag, and still zoomed — a drag is not a click, so it must
    // not fall through to the toggle and throw the zoom away.
    expect(Number.parseFloat(poster()?.style.left ?? '0')).toBeCloseTo(left + 50, 1)
    expect(poster()?.style.width).toBe(ORIGINAL)
  })

  it('does nothing on a drag while the whole picture is visible', () => {
    const onClose = vi.fn()
    renderLightbox({ seed: makeItem(1), onClose })

    pointer('pointerDown', 500, 400)
    pointer('pointerMove', 560, 460)
    pointer('pointerUp', 560, 460)

    expect(poster()?.style.width).toBe(FITTED)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves the zoom on the first Escape and the picture on the second', () => {
    // Closing outright from a zoom would lose your place in the grid to a
    // keypress that was only meant to undo the last thing you did.
    const onClose = vi.fn()
    renderLightbox({ seed: makeItem(1), onClose })
    click(500, 400)

    press('Escape')
    expect(poster()?.style.width).toBe(FITTED)
    expect(onClose).not.toHaveBeenCalled()

    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('zooms on alt-wheel and ignores a bare one', () => {
    renderLightbox({ seed: makeItem(1) })

    fireEvent.wheel(stage(), { deltaY: -100, clientX: 500, clientY: 400 })
    expect(poster()?.style.width).toBe(FITTED)

    fireEvent.wheel(stage(), { deltaY: -100, clientX: 500, clientY: 400, altKey: true })
    expect(Number.parseFloat(poster()?.style.width ?? '0')).toBeGreaterThan(1000)
  })

  it('will not zoom out past fitting', () => {
    renderLightbox({ seed: makeItem(1) })

    for (let i = 0; i < 20; i += 1) {
      fireEvent.wheel(stage(), { deltaY: 100, clientX: 500, clientY: 400, altKey: true })
    }

    // Fitting is the floor. Below it the picture would shrink into the middle
    // of a black window for no reason anyone asked for.
    expect(poster()?.style.width).toBe(FITTED)
  })

  it('returns to fitting when stepped to another picture', () => {
    // A pan is a position in *this* picture. Carrying it over lands you on an
    // arbitrary corner of a different one, with nothing saying that happened.
    const { rerender } = renderLightbox({ seed: makeItem(1) })
    click(500, 400)
    expect(poster()?.style.width).toBe(ORIGINAL)

    rerender(
      <Lightbox
        mediaId={2}
        seed={makeItem(2)}
        preload={[]}
        onClose={() => {}}
        onStep={() => {}}
        showBoxes={false}
        onToggleBoxes={() => {}}
        onExcludeFolder={() => {}}
        showGeneration={false}
        onToggleGeneration={() => {}}
        onDeleted={() => {}}
      onOpenId={() => {}}
      onToggleSelect={() => {}}
      />,
    )

    expect(poster()?.style.width).toBe(FITTED)
  })
})

describe('warming the neighbours', () => {
  it('fetches the thumbnails either side while this row is up', () => {
    renderLightbox({
      seed: makeItem(1),
      preload: [`${THUMB}-2`, `${THUMB}-3`, `${THUMB}-0`],
    })

    expect(warmed).toEqual([url(`${THUMB}-2`), url(`${THUMB}-3`), url(`${THUMB}-0`)])
  })

  it('asks for each one once, however often the parent re-renders', () => {
    // A scan pushes progress four times a second, and every one of those
    // re-renders the app. Refetching the same three thumbnails each time would
    // turn the warming into the load it exists to avoid.
    //
    // A **fresh array of the same paths** every render, which is what an
    // un-memoized parent hands over. That makes this cover both halves of the
    // guard — the effect not re-running, and the preloader refusing a URL it is
    // already fetching — so dropping either one fails here.
    const { rerender } = renderLightbox({ seed: makeItem(1), preload: [`${THUMB}-2`] })

    for (let i = 0; i < 5; i += 1) {
      rerender(
        <Lightbox
          mediaId={1}
          seed={makeItem(1)}
          preload={[`${THUMB}-2`]}
          onClose={() => {}}
          onStep={() => {}}
          showBoxes={false}
          onToggleBoxes={() => {}}
          onExcludeFolder={() => {}}
          showGeneration={false}
          onToggleGeneration={() => {}}
          onDeleted={() => {}}
      onOpenId={() => {}}
      onToggleSelect={() => {}}
        />,
      )
    }

    expect(warmed).toEqual([url(`${THUMB}-2`)])
  })
})
