import { CUSTOM_LORAS, loraCards, loraEntrySchema, loraRenderSearch, lorasByStatus } from '@luma/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LorasPanel } from '#/components/LorasPanel.tsx'

// Auto-cleanup is off in this suite, so a panel left mounted would answer the next test's clicks.
afterEach(cleanup)

const queryMedia = vi.hoisted(() => vi.fn())
const loraDataset = vi.hoisted(() => vi.fn())
const loraImagePreview = vi.hoisted(() => vi.fn())
vi.mock('#/lib/native.ts', () => ({
  queryMedia,
  loraDataset,
  loraImagePreview,
  fileUrl: (path: string) => `luma://${path}`,
}))
// Every test counts calls and installs its own answer, so nothing may carry over from the last one.
afterEach(() => {
  queryMedia.mockReset()
  loraDataset.mockReset()
  loraImagePreview.mockReset()
})

function page(paths: string[], prompts: string[] = []) {
  return {
    items: paths.map((path, index) => ({
      id: index,
      path,
      thumbPath: null,
      generation: prompts[index] === undefined ? null : { prompt: prompts[index] },
    })),
    total: paths.length,
    offset: 0,
  }
}

const CARDS = loraCards().length

describe('the LoRA catalogue', () => {
  it('every entry parses and names a version that is not in its own older list', () => {
    for (const entry of CUSTOM_LORAS) {
      expect(() => loraEntrySchema.parse(entry)).not.toThrow()
      expect(entry.olderVersions).not.toContain(entry.name)
    }
  })

  it('names each LoRA once across the whole catalogue, current and older alike', () => {
    const seen = new Set<string>()
    for (const entry of CUSTOM_LORAS) {
      for (const name of [entry.name, ...entry.olderVersions]) {
        expect(seen.has(name), `${name} is listed twice`).toBe(false)
        seen.add(name)
      }
    }
  })

  it('searches for the LoRA tag with its trailing colon, so a longer name cannot match', () => {
    expect(loraRenderSearch('ari_adopt_v1')).toBe('<lora:ari_adopt_v1:')
    expect('<lora:ari_adopt_v1b:1.0>').not.toContain(loraRenderSearch('ari_adopt_v1'))
  })
})

describe('LorasPanel', () => {
  it('shows one card per LoRA line in the two sections, and fetches renders for every LoRA', async () => {
    queryMedia.mockResolvedValue(page(['a.png', 'b.png', 'c.png']))
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    expect(screen.getByTestId('loras-final')).toBeTruthy()
    expect(screen.getByTestId('loras-wip')).toBeTruthy()
    expect(screen.getAllByTestId('lora-card')).toHaveLength(CARDS)
    // Every LoRA of every character asks for its renders, the variants included.
    await waitFor(() => expect(queryMedia).toHaveBeenCalledTimes(CUSTOM_LORAS.length))

    // Three starred renders fill a card, so no card asks a second time for unstarred ones.
    for (const call of queryMedia.mock.calls) {
      expect(call[0].minStars).toBe(1)
      expect(call[0].kind).toBe('image')
    }
    const groups = lorasByStatus()
    expect(groups.final.length + groups.wip.length).toBe(CUSTOM_LORAS.length)
  })

  it('gives a new line of a character its own card, in Work in progress while it trains', async () => {
    queryMedia.mockResolvedValue(page([]))
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    const ariCards = screen.getAllByTestId('lora-card').filter((card) => card.querySelector('h4')?.textContent === 'Ari')
    expect(ariCards).toHaveLength(2)
    // Both say which line they are, since the name alone would not tell them apart.
    expect(ariCards.map((card) => card.querySelector('h4 + code')?.textContent)).toEqual(['ari_adopt', 'ari_gen'])
    expect(screen.getByTestId('loras-wip').textContent).toContain('ari_gen_v4')
    expect(screen.getByTestId('loras-final').textContent).not.toContain('ari_gen_v4')
    await screen.findAllByText('No renders yet')
  })

  it('lists a character’s outfits under her card with one render each, not as cards of their own', async () => {
    queryMedia.mockResolvedValue(page(['a.png', 'b.png', 'c.png']))
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    const mira = screen.getAllByTestId('lora-card').find((card) => card.querySelector('h4')?.textContent === 'Mira Solen')!
    expect(mira).toBeTruthy()
    const rows = mira.querySelectorAll('[data-testid="lora-variant"]')
    expect(rows.length).toBeGreaterThanOrEqual(7)
    expect(mira.textContent).toContain('winter')
    expect(mira.textContent).toContain('plate armour')
    // One small render per variant, three on the main.
    await waitFor(() => expect(rows[0]!.querySelectorAll('img')).toHaveLength(1))
    expect(screen.getAllByRole('heading', { level: 4 }).filter((heading) => heading.textContent === 'Mira Solen')).toHaveLength(1)
  })

  it('shows the dressed cowboy front, the dressed cowboy back and the nude from behind, in that order', async () => {
    queryMedia.mockResolvedValue(
      page(
        ['nude-back.png', 'portrait.png', 'cowboy-back.png', 'cowboy-front.png'],
        [
          'ari, (completely nude:1.4), (from behind:1.3)',
          'ari, (portrait:1.4), face focus',
          'ari, (cowboy shot:1.4), (from behind:1.3)',
          'ari, (cowboy shot:1.4), looking at viewer',
        ],
      ),
    )
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    const shots = await screen.findAllByTitle('Open this render')
    const firstCard = shots.slice(0, 3).map((button) => button.querySelector('img')?.getAttribute('src'))
    expect(firstCard).toEqual(['luma://cowboy-front.png', 'luma://cowboy-back.png', 'luma://nude-back.png'])
    // The fetch is a pool the pick reads through, not the three best-scored frames.
    expect(queryMedia.mock.calls[0]![0].limit).toBeGreaterThan(3)
  })

  it('tops a short card up with unstarred renders of the same LoRA', async () => {
    queryMedia.mockImplementation((query: { minStars: number | null }) =>
      Promise.resolve(
        query.minStars === 1
          ? page(['starred.png'], ['ari, (cowboy shot:1.4)'])
          : page(['starred.png', 'any-1.png', 'any-2.png', 'any-3.png']),
      ),
    )
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    const shots = await screen.findAllByTitle('Open this render')
    const firstCard = shots.slice(0, 3).map((button) => button.querySelector('img')?.getAttribute('src'))
    expect(firstCard[0]).toBe('luma://starred.png')
    expect(firstCard.slice(1)).not.toContain('luma://starred.png')
    expect(firstCard.slice(1).every((src) => src?.startsWith('luma://any-'))).toBe(true)
    await waitFor(() => expect(queryMedia).toHaveBeenCalledTimes(CUSTOM_LORAS.length * 2))
  })

  it('has a Back button at the top left, and Escape, as ways out', () => {
    queryMedia.mockResolvedValue(page([]))
    const onClose = vi.fn()
    render(<LorasPanel onClose={onClose} onShowRenders={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back to the library' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('hands the grid that LoRA’s search from the "all renders" link', () => {
    queryMedia.mockResolvedValue(page(['a.png']))
    const onShowRenders = vi.fn()
    render(<LorasPanel onClose={() => {}} onShowRenders={onShowRenders} />)

    fireEvent.click(screen.getAllByRole('button', { name: 'all renders' })[0]!)
    expect(onShowRenders).toHaveBeenCalledWith(expect.stringMatching(/^<lora:.+:$/))
  })

  it('says "no renders yet" instead of linking to an empty grid for a LoRA nothing has used', async () => {
    queryMedia.mockResolvedValue(page([]))
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)
    await waitFor(() => expect(screen.getAllByText('no renders yet').length).toBeGreaterThan(0))
    expect(screen.queryByRole('button', { name: 'all renders' })).toBeNull()
  })

  it('opens a render at full size in the viewer, from the original rather than the thumbnail', async () => {
    queryMedia.mockResolvedValue({
      items: [{ id: 1, path: 'D:/out/full.png', thumbPath: 'T/full.jpg', generation: { prompt: 'ari, (cowboy shot:1.3)' } }],
      total: 1,
      offset: 0,
    })
    const onClose = vi.fn()
    render(<LorasPanel onClose={onClose} onShowRenders={() => {}} />)

    const shots = await screen.findAllByTitle('Open this render')
    expect(shots[0]!.querySelector('img')?.getAttribute('src')).toBe('luma://T/full.jpg')
    fireEvent.click(shots[0]!)
    const viewer = screen.getByTestId('viewer-backdrop')
    expect(viewer.querySelector('img')?.getAttribute('src')).toBe('luma://D:/out/full.png')

    // Escape closes the viewer, not the page.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('viewer-backdrop')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens a training image on its thumbnail and swaps in the sharper preview when it arrives', async () => {
    queryMedia.mockResolvedValue(page([]))
    loraDataset.mockResolvedValue({
      name: 'ari-adopt',
      config: 'dataset-adopt.toml',
      images: 1,
      perEpoch: 8,
      subsets: [
        {
          dir: 'refs',
          repeats: 8,
          images: [{ path: 'D:/x/refs/a.png', thumbPath: 'T/a.jpg', width: 1024, height: 1536, caption: 'ari, full body', flipped: false }],
        },
      ],
    })
    let deliver: (path: string) => void = () => {}
    loraImagePreview.mockImplementation(() => new Promise<string>((resolve) => (deliver = resolve)))
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    fireEvent.click((await screen.findAllByRole('button', { name: /Training images/ }))[0]!)
    const tile = await screen.findByTitle('ari, full body')
    fireEvent.click(tile)
    const viewer = screen.getByTestId('viewer-backdrop')
    expect(viewer.querySelector('img')?.getAttribute('src')).toBe('luma://T/a.jpg')
    expect(loraImagePreview).toHaveBeenCalledWith(loraCards()[0]!.main.dataset, 'D:/x/refs/a.png')

    deliver('T/a-preview.jpg')
    await waitFor(() => expect(viewer.querySelector('img')?.getAttribute('src')).toBe('luma://T/a-preview.jpg'))
  })

  it('unfolds the training images on request, one subset at a time, mirrors counted not shown', async () => {
    queryMedia.mockResolvedValue(page([]))
    loraDataset.mockResolvedValue({
      name: 'ari-adopt',
      config: 'dataset-adopt.toml',
      images: 3,
      perEpoch: 21,
      subsets: [
        {
          dir: 'refs',
          repeats: 8,
          images: [
            { path: 'D:/x/refs/a.png', thumbPath: 'T/a.jpg', width: 1024, height: 1536, caption: 'ari, 1girl, solo, full body', flipped: false },
            { path: 'D:/x/refs/a-flip.png', thumbPath: 'T/a-flip.jpg', width: 1024, height: 1536, caption: 'ari, 1girl, solo, full body', flipped: true },
          ],
        },
        { dir: 'refs-face', repeats: 5, images: [{ path: 'D:/x/refs-face/f.png', thumbPath: null, width: 0, height: 0, caption: null, flipped: false }] },
      ],
    })
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    // Folded until asked: nothing is read for two dozen cards nobody opened.
    expect(loraDataset).not.toHaveBeenCalled()
    const toggles = await screen.findAllByRole('button', { name: /Training images/ })
    // One per card on the page: the variants' fold-outs open only with their row.
    expect(toggles.length).toBe(CARDS)

    fireEvent.click(toggles[0]!)
    expect(loraDataset).toHaveBeenCalledWith(loraCards()[0]!.main.dataset)
    const subsets = await screen.findAllByTestId('lora-subset')
    expect(subsets).toHaveLength(2)
    expect(subsets[0]!.textContent).toContain('refs')
    expect(subsets[0]!.textContent).toContain('×8')
    expect(subsets[0]!.textContent).toContain('1 image + 1 mirrored')
    expect(subsets[0]!.querySelectorAll('img')).toHaveLength(1)
    expect(subsets[0]!.querySelector('button')?.getAttribute('title')).toBe('ari, 1girl, solo, full body')
    expect(subsets[1]!.textContent).toContain('no thumb')
    expect(screen.getByText(/21 per epoch/)).toBeTruthy()

    // Folding and unfolding again does not read twice.
    fireEvent.click(toggles[0]!)
    fireEvent.click(toggles[0]!)
    expect(loraDataset).toHaveBeenCalledTimes(1)
  })

  it('writes the Add-outfit message for the card’s character once the outfit is named', () => {
    queryMedia.mockResolvedValue(page([]))
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)

    const adds = screen.getAllByRole('button', { name: '+ Add outfit' })
    expect(adds).toHaveLength(CARDS)
    fireEvent.click(adds[0]!)
    const form = screen.getByTestId('add-outfit')
    expect(form.querySelector('textarea')).toBeNull()

    fireEvent.change(screen.getByLabelText('Outfit name'), { target: { value: 'Space Suit' } })
    fireEvent.change(screen.getByLabelText('Reference image path'), { target: { value: 'D:/refs/space.png' } })
    const message = (screen.getByLabelText('Message for Claude Code') as HTMLTextAreaElement).value
    const main = loraCards()[0]!.main
    expect(message.startsWith(`/character-refs ${main.trigger}-space-suit - outfit variant`)).toBe(true)
    expect(message).toContain('D:/refs/space.png')
    expect(form.textContent).toContain(`${main.trigger}spacesuit`)
  })

  it('says so rather than showing an empty strip when a LoRA has no render at all', async () => {
    queryMedia.mockResolvedValue(page([]))
    render(<LorasPanel onClose={() => {}} onShowRenders={() => {}} />)
    const empties = await screen.findAllByText('No renders yet')
    expect(empties.length).toBe(CARDS)
  })
})
