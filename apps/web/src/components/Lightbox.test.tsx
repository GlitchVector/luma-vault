import type { MediaItem } from '@luma/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogs } from '#/lib/dialogs.ts'
import { resetToasts, toast } from '#/lib/toasts.ts'

/** What extrasOriginal resolves to. Null unless a case sets it. */
let extrasOriginalState: import('@luma/core').MediaItem | null = null
/** What sourceOrigin resolves to, and how many rows asked for one. */
let sourceOriginState: import('@luma/core').SourceOrigin | null = null
let originCalls = 0
/**
 * Held open like `mediaById`, because "still looking" is a state the panel has
 * to render differently from "looked and found nothing" — a case that resolved
 * itself could not tell the two apart.
 */
let answerOrigin: (() => void) | null = null
import { ToastHost } from '#/components/ToastHost.tsx'
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
    deviantArt: null,
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
  extrasOriginal: () => Promise.resolve(extrasOriginalState),
  sourceOrigin: () => {
    originCalls += 1
    return new Promise<import('@luma/core').SourceOrigin | null>((resolve) => {
      answerOrigin = () => resolve(sourceOriginState)
    })
  },
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
  // Toasts hold a timer each; leaving them queued would let one raised by a
  // case fire into the next.
  resetToasts()
  extrasOriginalState = null
  sourceOriginState = null
  originCalls = 0
  answerOrigin = null
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
      onUpscale={() => {}}
      onToggleSelect={() => {}}
      selected={false}
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
      onUpscale={() => {}}
      onToggleSelect={() => {}}
      selected={false}
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
      onUpscale={() => {}}
      onToggleSelect={() => {}}
      selected={false}
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
      onUpscale={() => {}}
      onToggleSelect={() => {}}
      selected={false}
        />,
      )
    }

    expect(warmed).toEqual([url(`${THUMB}-2`)])
  })
})

describe('changing your mind about a picked picture', () => {
  const press = (key: string) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

  it('takes a picked picture back out when you rate it instead', () => {
    // The pass is: Down picks and moves on. Step back, decide it is a keeper
    // rather than a candidate, and Up has to undo the pick — otherwise the
    // batch action later runs over a picture you deliberately kept.
    const toggled: number[] = []
    renderLightbox({ seed: makeItem(7), selected: true, onToggleSelect: (id) => toggled.push(id) })

    press('ArrowUp')
    expect(toggled).toEqual([7])
  })

  it('does not start a selection by rating an unpicked one', () => {
    // `onToggleSelect` flips, so firing it blind here would *add* the row —
    // making Up on an ordinary picture silently begin a selection.
    const toggled: number[] = []
    renderLightbox({ seed: makeItem(7), selected: false, onToggleSelect: (id) => toggled.push(id) })

    press('ArrowUp')
    expect(toggled).toEqual([])
  })

  it('takes it back out when a digit rates it too', () => {
    // Any rating is the verdict that says this one is not a candidate, so the
    // number keys undo the pick just as Up does. They still do not step.
    const toggled: number[] = []
    renderLightbox({ seed: makeItem(7), selected: true, onToggleSelect: (id) => toggled.push(id) })

    press('3')
    expect(toggled).toEqual([7])
  })

  it('takes it back out even when the rating did not change', () => {
    // Pressing 4 on something already rated 4 writes nothing — but it is still
    // someone saying "this one is decided". The no-op check exists to skip a
    // pointless round trip, and must not swallow the half of the keypress that
    // has an effect.
    const toggled: number[] = []
    renderLightbox({
      seed: { ...makeItem(7), stars: 4 },
      selected: true,
      onToggleSelect: (id) => toggled.push(id),
    })

    press('4')
    expect(toggled).toEqual([7])
  })

  it('takes it back out when 0 clears the rating', () => {
    const toggled: number[] = []
    renderLightbox({
      seed: { ...makeItem(7), stars: 3 },
      selected: true,
      onToggleSelect: (id) => toggled.push(id),
    })

    press('0')
    expect(toggled).toEqual([7])
  })

  it('does not start a selection with a digit either', () => {
    const toggled: number[] = []
    renderLightbox({ seed: makeItem(7), selected: false, onToggleSelect: (id) => toggled.push(id) })

    press('3')
    expect(toggled).toEqual([])
  })

  it('says on screen that the picture is picked', () => {
    // Stepping back to reconsider is exactly when you need to know.
    renderLightbox({ seed: makeItem(7), selected: true })
    expect(screen.getByText('picked')).toBeTruthy()
  })

  it('says nothing when it is not', () => {
    renderLightbox({ seed: makeItem(7), selected: false })
    expect(screen.queryByText('picked')).toBeNull()
  })
})

describe('saying that a pick registered', () => {
  const press = (key: string) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

  function renderWithToasts(props: Partial<React.ComponentProps<typeof Lightbox>> = {}) {
    render(<ToastHost />)
    return renderLightbox(props)
  }

  const named = (name: string) => ({ ...makeItem(7), name })

  it('names the picture it just picked', async () => {
    // The selection lives in a grid the lightbox is covering, so without this
    // the key has no visible effect at all.
    renderWithToasts({ seed: named('holiday.png'), selected: false })
    press('ArrowDown')
    expect(await screen.findByText('Picked holiday.png')).toBeTruthy()
  })

  it('says so when the same key takes it back out', async () => {
    renderWithToasts({ seed: named('holiday.png'), selected: true })
    press('ArrowDown')
    expect(await screen.findByText('Unpicked holiday.png')).toBeTruthy()
  })

  it('says so when a rating takes it out', async () => {
    renderWithToasts({ seed: named('holiday.png'), selected: true })
    press('ArrowUp')
    expect(await screen.findByText('Unpicked holiday.png')).toBeTruthy()
  })

  it('says so when a digit takes it out', async () => {
    renderWithToasts({ seed: named('holiday.png'), selected: true })
    press('3')
    expect(await screen.findByText('Unpicked holiday.png')).toBeTruthy()
  })

  it('says nothing when a rating changed no pick', async () => {
    // Rating an unpicked picture is the ordinary case. A toast on every rating
    // would be constant noise through a pass.
    renderWithToasts({ seed: named('holiday.png'), selected: false })
    press('ArrowUp')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText(/^(Picked|Unpicked) holiday\.png$/)).toBeNull()
  })

  it('keeps only the newest few when a key is held through a folder', async () => {
    // These confirm a key meant to be repeated. Without a cap a fast pass
    // stacks them up the side of the window and pushes the newest — the only
    // one that matters — off screen.
    render(<ToastHost />)
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png']) {
      toast(`Picked ${name}`, 'picked')
    }
    expect(await screen.findByText('Picked e.png')).toBeTruthy()
    expect(screen.getAllByText(/^Picked /)).toHaveLength(3)
    expect(screen.queryByText('Picked a.png')).toBeNull()
  })
})

describe('the /sdxl hand-off', () => {
  const generated = (name: string) => ({
    ...makeItem(7),
    name,
    generation: { tool: 'Stable Diffusion', prompt: '1girl, silver hair', needsSourceImage: false, postprocessed: false },
  })

  it('offers the exact command for this picture', () => {
    // The filename is a counter and a seed. Retyping it by hand is the step
    // this removes.
    renderLightbox({ seed: generated('00042-3746152819.png'), showGeneration: true })
    expect(screen.getByText('/sdxl 00042-3746152819.png')).toBeTruthy()
  })

  it('puts it on the clipboard when clicked, and says it did', async () => {
    const written: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
      configurable: true,
    })

    renderLightbox({ seed: generated('00042-3746152819.png'), showGeneration: true })
    screen.getByText('/sdxl 00042-3746152819.png').click()

    expect(written).toEqual(['/sdxl 00042-3746152819.png'])
    // Confirmed on the control itself: a message elsewhere would answer a
    // different question than "did *this* copy".
    expect(await screen.findByText('copied')).toBeTruthy()
  })

  it('does not claim success when the browser refuses the clipboard', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    })

    renderLightbox({ seed: generated('a.png'), showGeneration: true })
    screen.getByText('/sdxl a.png').click()

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('copied')).toBeNull()
  })

  it('survives a webview with no clipboard at all', async () => {
    // `clipboard?.writeText()` yields undefined there, and `.then` on that
    // throws — which would take the click handler down rather than degrade.
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })

    renderLightbox({ seed: generated('a.png'), showGeneration: true })
    expect(() => screen.getByText('/sdxl a.png').click()).not.toThrow()
    expect(screen.queryByText('copied')).toBeNull()
  })

  it('is absent on a picture with no prompt data', () => {
    renderLightbox({ seed: makeItem(7), showGeneration: true })
    expect(screen.queryByText(/^\/sdxl /)).toBeNull()
  })
})

describe('where the /sdxl command sits', () => {
  it('is labelled, and comes after the settings rather than above the prompt', () => {
    // The panel reads top to bottom as "what this picture is" — prompt, then
    // settings. Handing off to another tool is what you do about it afterwards,
    // so it goes last.
    renderLightbox({
      seed: {
        ...makeItem(7),
        name: 'a.png',
        generation: {
          tool: 'Stable Diffusion',
          prompt: '1girl, silver hair',
          model: 'waiNSFW.safetensors',
          needsSourceImage: false, postprocessed: false,
        },
      },
      showGeneration: true,
    })

    expect(screen.getByText('SDXL Claude Command')).toBeTruthy()

    const panel = screen.getByText('/sdxl a.png').closest('aside')
    expect(panel).toBeTruthy()
    const order = [...(panel?.querySelectorAll('*') ?? [])]
    const at = (text: string) =>
      order.findIndex((node) => node.textContent?.trim() === text)

    expect(at('SDXL Claude Command')).toBeGreaterThan(at('1girl, silver hair'))
    expect(at('/sdxl a.png')).toBeGreaterThan(at('SDXL Claude Command'))
  })
})

describe('an Extras upscale in the lightbox', () => {
  const extras = () => ({
    ...makeItem(7),
    name: '00042-upscaled.png',
    generation: {
      tool: 'Stable Diffusion',
      prompt: 'Postprocess upscale by: 2, Postprocess upscaler: 4x-UltraSharp',
      needsSourceImage: false, postprocessed: true,
    },
  })

  it('shows the ORIGINAL prompt in the panel, with the extras pass after it', async () => {
    // The prompt someone opens the panel for is the prompt of the thing that
    // was upscaled — the extras block itself has no prompt, only the
    // postprocess line, which appears after as its own section.
    extrasOriginalState = {
      ...makeItem(3),
      name: 'original.png',
      generation: {
        tool: 'Stable Diffusion',
        prompt: 'aqua (konosuba), ocean, huge ass',
        needsSourceImage: false, postprocessed: false,
      },
    }
    renderLightbox({ seed: extras(), showGeneration: true })

    expect(await screen.findByText('aqua (konosuba), ocean, huge ass')).toBeTruthy()
    expect(screen.getByText('Extras pass')).toBeTruthy()
    expect(screen.getByText(/Postprocess upscale by: 2/)).toBeTruthy()
    // The /sdxl hand-off migrates the original, not the upscale.
    expect(screen.getByText('/sdxl original.png')).toBeTruthy()
  })

  it('falls back to its own metadata when no original is linked, and says so', async () => {
    renderLightbox({ seed: extras(), showGeneration: true })

    expect(await screen.findByText('Extras pass')).toBeTruthy()
    expect(screen.getByText(/Run Find Duplicates to link/)).toBeTruthy()
  })

  it('wears the extras pill in the footer', async () => {
    renderLightbox({
      seed: {
        ...extras(),
        verdict: {
          person: true, sexy: false, nude: false, rating: 'sfw',
          topLabel: null, topLabelTitle: null, topScore: 0,
          frameCount: 1, sexyFrameCount: 0, posterFrameIndex: null,
        },
      },
    })
    expect(await screen.findByText('extras')).toBeTruthy()
  })
})

describe('the extras pill swaps the image', () => {
  const extrasSeed = () => ({
    ...makeItem(7),
    name: '00000.png',
    thumbPath: '/thumbs/aa/bb/extras-upscale.png',
    generation: {
      tool: 'Stable Diffusion', prompt: 'copied original block',
      needsSourceImage: false, postprocessed: true,
    },
    verdict: {
      person: true, sexy: false, nude: false, rating: 'sfw' as const,
      topLabel: null, topLabelTitle: null, topScore: 0,
      frameCount: 1, sexyFrameCount: 0, posterFrameIndex: null,
    },
  })

  it('flips to the original and back, swapping only the drawn file', async () => {
    extrasOriginalState = {
      ...makeItem(3),
      name: 'source.png',
      thumbPath: '/thumbs/cc/dd/the-original.png',
      generation: {
        tool: 'Stable Diffusion', prompt: '1girl',
        needsSourceImage: false, postprocessed: false,
      },
    }
    renderLightbox({ seed: extrasSeed() })

    const pill = await screen.findByText('extras')
    // The poster is painted as a CSS background and the full file mounts as
    // an <img> after the dwell — the swap must show in whichever is present.
    const drawn = () => [
      ...[...document.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? ''),
      ...[...document.querySelectorAll('div')].map((div) => div.style.backgroundImage ?? ''),
    ]

    await waitFor(() => expect(drawn().some((src) => src.includes('extras-upscale'))).toBe(true))
    pill.click()
    // Label flips, and the stage now draws the original's file.
    expect(await screen.findByText('original')).toBeTruthy()
    await waitFor(() =>
      expect(drawn().some((src) => src.includes('the-original'))).toBe(true),
    )

    screen.getByText('original').click()
    expect(await screen.findByText('extras')).toBeTruthy()
    await waitFor(() =>
      expect(drawn().some((src) => src.includes('extras-upscale'))).toBe(true),
    )
  })

  it('stays inert when no original was found, and says why', async () => {
    renderLightbox({ seed: extrasSeed() })
    const pill = await screen.findByText('extras')
    pill.click()
    // No flip — there is nothing to flip to — and the title explains.
    expect(screen.queryByText('original')).toBeNull()
    expect(pill.closest('button')?.title).toMatch(/was not found/)
  })
})

/**
 * The panel used to say the source image "is not recorded in any file … and
 * cannot be recovered", full stop. Nothing records it, but the library can
 * often *recognise* it — and when it does, the prompt that actually describes
 * the picture is the ancestor's, not this row's.
 */
describe('what an img2img was made from', () => {
  const img2imgSeed = () =>
    makeItem(1, {
      generation: {
        tool: 'Stable Diffusion',
        // The real shape of the problem: an inpaint repairing a hand, whose
        // prompt says nothing whatever about who is in the picture.
        prompt: 'very detailed human left hand',
        needsSourceImage: true,
        postprocessed: false,
      },
    })

  const ancestor = makeItem(99, {
    name: '00352-3427824797.png',
    generation: {
      tool: 'Stable Diffusion',
      prompt: '1girl, kiryu coco, dragon horns, small china dress',
      needsSourceImage: false,
      postprocessed: false,
    },
  })

  it('does not call a picture sourceless while it is still looking', async () => {
    sourceOriginState = { item: ancestor, hops: 6, reachedRoot: true, weakestHop: 6 }
    renderLightbox({ seed: img2imgSeed(), showGeneration: true })

    expect(await screen.findByText(/Looking for it/)).toBeTruthy()
    expect(screen.queryByText(/Nothing here looks like its source/)).toBeNull()
  })

  it('names the ancestor and shows the prompt this row never carried', async () => {
    sourceOriginState = { item: ancestor, hops: 6, reachedRoot: true, weakestHop: 6 }
    const { container } = renderLightbox({ seed: img2imgSeed(), showGeneration: true })
    await screen.findByText(/Looking for it/)

    await act(async () => {
      answerOrigin?.()
    })

    expect(screen.getByRole('button', { name: '00352-3427824797.png' })).toBeTruthy()
    expect(container.textContent).toContain('6 img2img passes back')
    expect(screen.getByText(/kiryu coco, dragon horns, small china dress/)).toBeTruthy()
  })

  it('opens the ancestor when its name is clicked', async () => {
    sourceOriginState = { item: ancestor, hops: 2, reachedRoot: true, weakestHop: 5 }
    const opened: number[] = []
    renderLightbox({
      seed: img2imgSeed(),
      showGeneration: true,
      onOpenId: (id) => opened.push(id),
    })
    await screen.findByText(/Looking for it/)
    await act(async () => {
      answerOrigin?.()
    })

    screen.getByRole('button', { name: '00352-3427824797.png' }).click()
    expect(opened).toEqual([99])
  })

  it('says the trail went cold rather than calling the ancestor the original', async () => {
    // 40% of real cases. Presenting this one as where the lineage started
    // would be a claim the data does not support.
    sourceOriginState = {
      item: { ...ancestor, generation: { ...ancestor.generation!, needsSourceImage: true } },
      hops: 1,
      reachedRoot: false,
      weakestHop: 8,
    }
    const { container } = renderLightbox({ seed: img2imgSeed(), showGeneration: true })
    await screen.findByText(/Looking for it/)
    await act(async () => {
      answerOrigin?.()
    })

    expect(container.textContent).toContain('An earlier picture in the same lineage')
    expect(container.textContent).not.toContain('The picture this one starts from')
  })

  it('says so plainly when nothing in the library looks like the source', async () => {
    sourceOriginState = null
    renderLightbox({ seed: img2imgSeed(), showGeneration: true })
    await screen.findByText(/Looking for it/)
    await act(async () => {
      answerOrigin?.()
    })

    expect(screen.getByText(/Nothing here looks like its source/)).toBeTruthy()
  })

  it('never asks for a row that was not made from another image', async () => {
    // The walk scans every fingerprinted row in the library. Running it for a
    // txt2img would be that cost spent looking for something that cannot exist.
    renderLightbox({
      seed: makeItem(1, {
        generation: {
          tool: 'Stable Diffusion',
          prompt: '1girl, silver hair',
          needsSourceImage: false,
          postprocessed: false,
        },
      }),
      showGeneration: true,
    })
    await screen.findByText('1girl, silver hair')

    expect(originCalls).toBe(0)
  })
})

describe('an Extras upscale of an img2img', () => {
  it('looks up the source of the row whose prompt the panel is showing', async () => {
    // The panel shows the upscaled picture's generation, not the postprocess
    // line. Keying the lookup on the row on screen instead asked about a row
    // that is not an img2img — so nothing was ever requested and the panel sat
    // on "looking for it" for good.
    const upscaled = makeItem(1, {
      name: 'holiday-1-gigapixel.png',
      generation: {
        tool: 'Stable Diffusion',
        prompt: 'very detailed human left hand',
        needsSourceImage: true,
        postprocessed: true,
      },
    })
    extrasOriginalState = makeItem(50, {
      name: '00244-529498367.png',
      generation: {
        tool: 'Stable Diffusion',
        prompt: 'very detailed human left hand',
        needsSourceImage: true,
        postprocessed: false,
      },
    })
    sourceOriginState = {
      item: makeItem(99, {
        name: '00083-3427824797.png',
        generation: {
          tool: 'Stable Diffusion',
          prompt: '1girl, kiryu coco, small china dress',
          needsSourceImage: false,
          postprocessed: false,
        },
      }),
      hops: 6,
      reachedRoot: true,
      weakestHop: 5,
    }

    renderLightbox({ seed: upscaled, showGeneration: true })
    await waitFor(() => expect(originCalls).toBe(1))
    await act(async () => {
      answerOrigin?.()
    })

    expect(screen.getByRole('button', { name: '00083-3427824797.png' })).toBeTruthy()
    expect(screen.queryByText(/Looking for it/)).toBeNull()
  })
})
