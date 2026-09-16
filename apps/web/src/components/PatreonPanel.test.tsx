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

vi.mock('#/lib/native.ts', () => ({
  fileUrl: (path: string) => path,
  openExternal: vi.fn(),
  onPatreonProgress: async () => () => {},
  patreonPost: (...args: unknown[]) => patreonPost(...args),
  reorderSet: (...args: unknown[]) => reorderSet(...args),
  reorderSets: (...args: unknown[]) => reorderSets(...args),
}))

import { PatreonPanel } from './PatreonPanel.tsx'

function item(id: number, name: string): MediaItem {
  return {
    id,
    folderId: 1,
    path: `/vault/${name}`,
    name,
    kind: 'image',
    width: 832,
    height: 1216,
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
  }
}

const items = [item(1, '01.png'), item(2, '02.png'), item(3, '03.png')]
const members: SetMemberRow[] = [
  { mediaId: 1, run: 'run-a', label: 'stage 1 — cowboy shot', position: 0 },
  { mediaId: 2, run: 'run-a', label: 'stage 1 — portrait', position: 1 },
  { mediaId: 3, run: 'run-a', label: 'act 7 — spitroast', position: 2 },
]

function names(): string[] {
  return screen
    .getAllByTestId(/patreon-row-/)
    .map((row) => row.textContent ?? '')
    .map((text) => (/0\d\.png/.exec(text) ?? [''])[0])
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
})
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
  it('will not post until the adult flag has been stated and there is a title', async () => {
    render(<PatreonPanel items={items} sets={['run-a']} members={members} setTitle={null} onClose={vi.fn()} onReordered={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Create draft' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('what this post is called'), { target: { value: 'a title' } })
    expect(button.disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('yes'))
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    // The call sits behind the progress subscription, so it lands a tick later.
    await vi.waitFor(() =>
      expect(patreonPost).toHaveBeenCalledWith({ ids: [1, 2, 3], title: 'a title', body: '', tiers: [], adult: true }),
    )
  })
})
