import type { MediaItem, SetMemberRow } from '@luma/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reorderSet = vi.fn(async (..._args: unknown[]) => 1)
const reorderSets = vi.fn(async (..._args: unknown[]) => 2)
// Resolves, because the panel chains `.then` on it — a mock returning
// undefined makes that chain throw after the assertion, as an unhandled
// rejection that fails the run with every test green.
const patreonPost = vi.fn(async (..._args: unknown[]) => ({
  url: 'https://www.patreon.com/posts/1/edit',
  postId: '1',
  uploaded: 3,
  reused: 0,
  error: null,
  log: [],
}))

/** The index, as far as `mediaByPath` is concerned. Tests fill it. */
const indexed = new Map<string, MediaItem>()
const upscaleMedia = vi.fn(async (_ids: number[]) => ({
  upscaled: 0,
  skipped: 0,
  alreadyLarge: 0,
  failed: 0,
  seconds: 0,
  peakVramMb: 0,
  model: '',
  architecture: '',
  outputs: [] as { source: string; destination: string; name: string }[],
  errors: [] as string[],
}))

/** The campaign's rules, as `tiers --json` reports them for this page. */
const bare = { title: null, amountCents: null, currency: null }
const RULES = [
  { id: '68432072', type: 'public', ...bare },
  { id: '68432073', type: 'patrons', ...bare },
  { id: '68432074', type: 'tier', title: 'Free', amountCents: 0, currency: 'USD' },
  { id: '68475609', type: 'tier', title: 'Tip Jar', amountCents: 300, currency: 'USD' },
  { id: '68475917', type: 'tier', title: 'Supporter', amountCents: 1000, currency: 'USD' },
]
const patreonTiers = vi.fn(async () => RULES)

vi.mock('#/lib/native.ts', () => ({
  fileUrl: (path: string) => path,
  openExternal: vi.fn(),
  onPatreonProgress: async () => () => {},
  onUpscaleProgress: async () => () => {},
  mediaByPath: async (path: string) => indexed.get(path) ?? null,
  upscaleMedia: (ids: number[]) => upscaleMedia(ids),
  patreonPost: (...args: unknown[]) => patreonPost(...args),
  patreonTiers: () => patreonTiers(),
  reorderSet: (...args: unknown[]) => reorderSet(...args),
  reorderSets: (...args: unknown[]) => reorderSets(...args),
}))

import { PatreonPanel } from './PatreonPanel.tsx'

function item(id: number, name: string, extra: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    folderId: 1,
    path: `/vault/${name}`,
    name,
    kind: 'image',
    // Already 4K, so the ordering and drag tests are not also 4K tests.
    width: 3840,
    height: 5616,
    sizeBytes: 1,
    modifiedAt: 1,
    addedAt: 1,
    thumbPath: null,
    thumbWidth: null,
    thumbHeight: null,
    durationSec: null,
    verdict: null,
    classifiedAt: null,
    stars: null,
    generation: null,
    dupeGroup: null,
    upscaledFrom: null,
    upscaledTo: null,
    ratingOverride: null,
    deviantArt: null,
    patreon: null,
    ...extra,
  }
}

/** A picture at render size, with no 4K version anywhere. */
const small = (id: number, name: string, extra: Partial<MediaItem> = {}) =>
  item(id, name, { width: 832, height: 1216, ...extra })

const items = [item(1, '01.png'), item(2, '02.png'), item(3, '03.png')]
const members: SetMemberRow[] = [
  { mediaId: 1, run: 'run-a', label: 'stage 1 — cowboy shot', position: 0 },
  { mediaId: 2, run: 'run-a', label: 'stage 1 — portrait', position: 1 },
  { mediaId: 3, run: 'run-a', label: 'act 7 — spitroast', position: 2 },
]

function names(): string[] {
  // The name has its own element: reading it out of the row's text would have
  // to skip the index that sits in front of it, which is how this once read
  // "01.png" as "101.png".
  return screen.getAllByTestId('patreon-name').map((element) => element.textContent?.trim() ?? '')
}

/** A drag from row `from` dropped onto row `onto`, with the events jsdom needs. */
function drag(from: number, onto: number) {
  const rows = screen.getAllByTestId(/patreon-row-/)
  fireEvent.dragStart(rows[from] as HTMLElement)
  fireEvent.dragOver(rows[onto] as HTMLElement)
  fireEvent.drop(rows[onto] as HTMLElement)
}

beforeEach(() => {
  reorderSet.mockClear()
  reorderSets.mockClear()
  patreonPost.mockClear()
  upscaleMedia.mockClear()
  patreonTiers.mockClear()
  indexed.clear()
})

/** Everything the button needs besides the 4K decision: a title, the adult flag, an audience. */
function stateAdultWithTitle() {
  fireEvent.change(screen.getByPlaceholderText('what this post is called'), { target: { value: 'a title' } })
  fireEvent.click(screen.getByLabelText('yes'))
  fireEvent.click(screen.getByLabelText('Everyone'))
}
afterEach(cleanup)

describe('PatreonPanel', () => {
  it('shows the pictures in the order it was given, under their stage and act headings', () => {
    render(
      <PatreonPanel items={items} sets={['run-a']} members={members} setTitle="Mira — set 042" onClose={vi.fn()} onReordered={vi.fn()} />,
    )
    expect(names()).toEqual(['01.png', '02.png', '03.png'])
    expect(screen.getByText('stage 1')).toBeTruthy()
    expect(screen.getByText('act 7')).toBeTruthy()
    // Prefilled from the set, since a shoot that named itself already said
    // what the post is called.
    expect((screen.getByPlaceholderText('what this post is called') as HTMLInputElement).value).toBe('Mira — set 042')
  })

  // The order shown is the order posted, and a drag is the final word — so it
  // has to reach the manifest, not just this list.
  it('writes a drag back to the one set showing, in the new path order', async () => {
    const onReordered = vi.fn()
    render(
      <PatreonPanel items={items} sets={['run-a']} members={members} setTitle={null} onClose={vi.fn()} onReordered={onReordered} />,
    )
    drag(2, 0)
    expect(names()).toEqual(['03.png', '01.png', '02.png'])
    expect(reorderSet).toHaveBeenCalledWith('run-a', ['/vault/03.png', '/vault/01.png', '/vault/02.png'])
    await vi.waitFor(() => expect(onReordered).toHaveBeenCalledOnce())
  })

  // With several sets the drag is split per set; this panel only has to hand
  // the whole merged order to the backend, which knows the membership.
  it('hands a merged drag to reorderSets when several sets are showing', () => {
    render(
      <PatreonPanel items={items} sets={['run-a', 'run-b']} members={members} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />,
    )
    drag(0, 2)
    expect(reorderSets).toHaveBeenCalledWith(['run-a', 'run-b'], ['/vault/02.png', '/vault/01.png', '/vault/03.png'])
    expect(reorderSet).not.toHaveBeenCalled()
  })

  it('touches no manifest for a loose selection', () => {
    render(<PatreonPanel items={items} sets={[]} members={[]} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />)
    drag(0, 2)
    expect(names()).toEqual(['02.png', '01.png', '03.png'])
    expect(reorderSet).not.toHaveBeenCalled()
    expect(reorderSets).not.toHaveBeenCalled()
  })

  // The adult flag is stated, never defaulted: the client checks it against
  // the campaign, and a ticked box is a fact where a default would be a guess.
  it('will not post until the adult flag, the audience and a title have all been given', async () => {
    render(<PatreonPanel items={items} sets={['run-a']} members={members} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('what this post is called'), { target: { value: 'a title' } })
    expect(button.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('yes'))
    expect(button.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('Everyone'))
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    // The call sits behind the progress subscription, so it lands a tick later.
    await vi.waitFor(() =>
      expect(patreonPost).toHaveBeenCalledWith({ ids: [1, 2, 3], title: 'a title', body: '', tiers: [], adult: true }),
    )
  })

  // Everything that goes up is 4K. The grid shows originals and hides their
  // variants, so a selection is originals; these pin what the panel does about
  // that, and that it is one question for the batch.
  describe('the 4K check', () => {
    it('asks once about the pictures with no 4K version, and will not post until answered', () => {
      render(
        <PatreonPanel
          items={[item(1, '01.png'), small(2, '02.png'), small(3, '03.png')]}
          sets={[]}
          members={[]}
          setTitle={null}
          onClose={vi.fn()}
          onReordered={vi.fn()}
        />,
      )
      expect(screen.getByRole('group', { name: '4K check' }).textContent).toContain('2 of 3 have no 4K version')
      stateAdultWithTitle()
      expect((screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement).disabled).toBe(true)
    })

    it('posts the originals when told to post as they are', async () => {
      render(
        <PatreonPanel items={[small(2, '02.png')]} sets={[]} members={[]} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Post as they are' }))
      stateAdultWithTitle()
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
      await vi.waitFor(() => expect(patreonPost).toHaveBeenCalledWith(expect.objectContaining({ ids: [2] })))
      expect(upscaleMedia).not.toHaveBeenCalled()
    })

    // The upscaler writes beside the original and the watcher indexes it a
    // few seconds later; the index is what turns that file into a row the
    // post can name. So the destination is looked up, and the 4K row stands
    // in for the original — in the original's place.
    it('upscales only the ones that need it, then posts the 4K rows in the same order', async () => {
      const fourK = item(20, '02_upscaled_4k.png', { upscaledFrom: '/vault/02.png' })
      upscaleMedia.mockResolvedValueOnce({
        upscaled: 1, skipped: 0, alreadyLarge: 0, failed: 0, seconds: 1, peakVramMb: 0, model: '', architecture: '',
        outputs: [{ source: '/vault/02.png', destination: '/vault/02_upscaled_4k.png', name: '02_upscaled_4k.png' }],
        errors: [],
      })
      indexed.set('/vault/02_upscaled_4k.png', fourK)

      render(
        <PatreonPanel
          items={[item(1, '01.png'), small(2, '02.png'), item(3, '03.png')]}
          sets={[]}
          members={[]}
          setTitle={null}
          onClose={vi.fn()}
          onReordered={vi.fn()}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: /Upscale the 1 first/ }))
      // Behind the progress subscription, so a tick later.
      await vi.waitFor(() => expect(upscaleMedia).toHaveBeenCalledWith([2]))

      await vi.waitFor(() => expect(screen.queryByTestId('patreon-row-20')).toBeTruthy())
      expect(names()).toEqual(['01.png', '02_upscaled_4k.png', '03.png'])

      stateAdultWithTitle()
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
      await vi.waitFor(() => expect(patreonPost).toHaveBeenCalledWith(expect.objectContaining({ ids: [1, 20, 3] })))
    })

    // "Always 4K" means a picture whose variant already exists is swapped
    // silently: nothing to ask, the file is there.
    it('swaps a picture for its existing 4K version without asking', async () => {
      const fourK = item(10, '01_upscaled_4k.png', { upscaledFrom: '/vault/01.png' })
      indexed.set('/vault/01_upscaled_4k.png', fourK)
      render(
        <PatreonPanel
          items={[small(1, '01.png', { upscaledTo: '/vault/01_upscaled_4k.png' })]}
          sets={[]}
          members={[]}
          setTitle={null}
          onClose={vi.fn()}
          onReordered={vi.fn()}
        />,
      )
      await vi.waitFor(() => expect(names()).toEqual(['01_upscaled_4k.png']))
      expect(screen.queryByRole('group', { name: '4K check' })).toBeNull()
      expect(upscaleMedia).not.toHaveBeenCalled()
    })

    it('leaves videos and pictures that are already 4K out of the question', () => {
      render(
        <PatreonPanel
          items={[item(1, '01.png'), small(2, 'clip.mp4', { kind: 'video' })]}
          sets={[]}
          members={[]}
          setTitle={null}
          onClose={vi.fn()}
          onReordered={vi.fn()}
        />,
      )
      expect(screen.queryByRole('group', { name: '4K check' })).toBeNull()
    })

    // A drag writes the set's own names back — the originals' — even when a
    // 4K variant is standing in for one here. The set never named the variant.
    it('writes the originals back to the set even when a 4K row stands in', async () => {
      const fourK = item(10, '01_upscaled_4k.png', { upscaledFrom: '/vault/01.png' })
      indexed.set('/vault/01_upscaled_4k.png', fourK)
      render(
        <PatreonPanel
          items={[small(1, '01.png', { upscaledTo: '/vault/01_upscaled_4k.png' }), item(2, '02.png')]}
          sets={['run-a']}
          members={[]}
          setTitle={null}
          onClose={vi.fn()}
          onReordered={vi.fn()}
        />,
      )
      await vi.waitFor(() => expect(names()).toEqual(['01_upscaled_4k.png', '02.png']))
      drag(1, 0)
      expect(reorderSet).toHaveBeenCalledWith('run-a', ['/vault/02.png', '/vault/01.png'])
    })
  })

  // The first draft this panel ever made went up free, because the audience
  // was a text field for ids. These pin the editor's three choices, by name.
  describe('who can see it', () => {
    it('offers the campaign tiers by name and price, once read', async () => {
      render(<PatreonPanel items={items} sets={[]} members={[]} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />)
      await vi.waitFor(() => expect(patreonTiers).toHaveBeenCalledOnce())
      fireEvent.click(screen.getByLabelText('Some tiers'))
      expect(screen.getByLabelText(/Supporter/).closest('label')?.textContent).toContain('$10.00')
      expect(screen.getByLabelText(/Tip Jar/)).toBeTruthy()
    })

    it('locks to every paid member with the campaign own patrons rule', async () => {
      render(<PatreonPanel items={items} sets={[]} members={[]} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />)
      await vi.waitFor(() => expect(patreonTiers).toHaveBeenCalledOnce())
      fireEvent.change(screen.getByPlaceholderText('what this post is called'), { target: { value: 'a title' } })
      fireEvent.click(screen.getByLabelText('yes'))
      fireEvent.click(screen.getByLabelText('Paid members'))
      fireEvent.click(screen.getByRole('button', { name: 'Create draft' }))
      await vi.waitFor(() =>
        expect(patreonPost).toHaveBeenCalledWith(expect.objectContaining({ tiers: ['68432073'] })),
      )
    })

    it('locks to the picked tiers, and to nobody until one is picked', async () => {
      render(<PatreonPanel items={items} sets={[]} members={[]} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />)
      await vi.waitFor(() => expect(patreonTiers).toHaveBeenCalledOnce())
      fireEvent.change(screen.getByPlaceholderText('what this post is called'), { target: { value: 'a title' } })
      fireEvent.click(screen.getByLabelText('yes'))
      fireEvent.click(screen.getByLabelText('Some tiers'))
      const button = screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement
      // "Some tiers" with none ticked would lock the post to nobody.
      expect(button.disabled).toBe(true)

      fireEvent.click(screen.getByLabelText(/Supporter/))
      fireEvent.click(screen.getByLabelText(/Tip Jar/))
      expect(button.disabled).toBe(false)
      fireEvent.click(button)
      await vi.waitFor(() =>
        expect(patreonPost).toHaveBeenCalledWith(expect.objectContaining({ tiers: ['68475609', '68475917'] })),
      )
    })

    it('says so when the campaign could not be read, and still allows a public post', async () => {
      patreonTiers.mockRejectedValueOnce(new Error('the Patreon client is not here'))
      render(<PatreonPanel items={items} sets={[]} members={[]} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />)
      await vi.waitFor(() => expect(screen.getByText(/could not read the campaign/).textContent).toContain('not here'))
      stateAdultWithTitle()
      expect((screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })
})
