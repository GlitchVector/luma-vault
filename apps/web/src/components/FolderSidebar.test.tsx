import type { SetSummary } from '@luma/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FolderSidebar, LORA_COMMAND, type Page } from './FolderSidebar.tsx'

/**
 * A LoRA training round and a photo shoot are both "sets", and for a while they
 * shared one list. They should not: a round is forty near-identical candidates
 * that exist to be judged once, and enough of them buries every shoot in the
 * library. These tests pin the separation, because the only thing holding it is
 * a string equality that a refactor could quietly widen.
 */

function set(run: string, command: string, character: string): SetSummary {
  return {
    run,
    command,
    character,
    title: null,
    createdAt: Date.UTC(2026, 8, 13),
    count: 42,
    posterId: null,
  }
}

const sets = [
  set('lora-ari-r1-1', LORA_COMMAND, 'ari-r1'),
  set('lora-rati-r1-1', LORA_COMMAND, 'rati-r1'),
  set('shotall-mira-1', 'shotall', 'mira'),
  set('photostory-mira-1', 'photostory', 'mira'),
]

const onSets = vi.fn()
const onPage = vi.fn()

function sidebar(given: SetSummary[] = sets, extra: { page?: Page; selectedSets?: string[]; onHome?: () => void } = {}) {
  return (
    <FolderSidebar
      folders={[]}
      stats={null}
      page={extra.page ?? 'library'}
      onPage={onPage}
      characters={[]}
      onCharacter={vi.fn()}
      sets={given}
      selectedSets={extra.selectedSets ?? []}
      onSets={onSets}
      onHome={extra.onHome ?? vi.fn()}
      tileSize={300}
      onTileSize={vi.fn()}
      selectedFolderId={null}
      onSelect={vi.fn()}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onRescan={vi.fn()}
      onRetryFailed={vi.fn()}
      onImportRatings={vi.fn()}
      exclusions={[]}
      onInclude={vi.fn()}
    />
  )
}

const heading = (label: RegExp) => screen.getByRole('button', { name: label })

beforeEach(() => {
  // Section state is remembered per browser; a test must start from the defaults.
  globalThis.localStorage?.clear()
})

afterEach(() => {
  cleanup()
  onSets.mockReset()
  onPage.mockReset()
})

describe('FolderSidebar navigation', () => {
  it('lists the pages, marks the current one, and a click asks for another', () => {
    render(sidebar(sets, { page: 'loras' }))
    const nav = screen.getByRole('navigation', { name: 'Pages' })
    expect(nav.textContent).toContain('Library')
    expect(nav.textContent).toContain('Comics')
    expect(heading(/^LoRAs/).getAttribute('aria-current')).toBe('page')
    expect(heading(/^Library/).getAttribute('aria-current')).toBeNull()

    fireEvent.click(heading(/^Comics/))
    expect(onPage).toHaveBeenLastCalledWith('comics')
    fireEvent.click(heading(/^Library/))
    expect(onPage).toHaveBeenLastCalledWith('library')
  })
})

describe('FolderSidebar sections', () => {
  it('lends the Comics page a section for its list, and only that page', () => {
    const comicsSlot = vi.fn()
    const { unmount } = render(
      <FolderSidebar
        folders={[]}
        stats={null}
        page="comics"
        onPage={onPage}
        characters={[]}
        onCharacter={vi.fn()}
        sets={[]}
        selectedSets={[]}
        onSets={onSets}
        onHome={vi.fn()}
        tileSize={300}
        onTileSize={vi.fn()}
        selectedFolderId={null}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onRescan={vi.fn()}
        onRetryFailed={vi.fn()}
        onImportRatings={vi.fn()}
        exclusions={[]}
        onInclude={vi.fn()}
        comicsSlot={comicsSlot}
      />,
    )
    expect(screen.getByTestId('comics-slot')).toBeTruthy()
    expect(comicsSlot).toHaveBeenCalledWith(expect.any(HTMLDivElement))
    unmount()

    render(sidebar(sets, { page: 'library' }))
    expect(screen.queryByTestId('comics-slot')).toBeNull()
  })

  it('keeps the training rounds out of Sets, and Sets is open by default', () => {
    render(sidebar())
    expect(screen.getByText('mira')).toBeTruthy()
    expect(screen.queryByText('ari-r1')).toBeNull()
    expect(screen.queryByText('rati-r1')).toBeNull()
  })

  it('lists only the training rounds under LoRA sets, and opening it closes Sets', () => {
    render(sidebar())
    expect(heading(/^LoRA sets/).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(heading(/^LoRA sets/))
    expect(screen.getByText('ari-r1')).toBeTruthy()
    expect(screen.getByText('rati-r1')).toBeTruthy()
    // An accordion: the shoots folded away when the rounds opened.
    expect(screen.queryByText('mira')).toBeNull()
    expect(heading(/^Sets/).getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(heading(/^Sets/))
    expect(screen.getByText('mira')).toBeTruthy()
    expect(screen.queryByText('ari-r1')).toBeNull()
  })

  it('opens Characters by default and remembers which list was left open', () => {
    const { unmount } = render(
      <FolderSidebar
        folders={[]}
        stats={null}
        page="library"
        onPage={onPage}
        characters={[{ name: 'aqua (konosuba)', count: 3 }]}
        onCharacter={vi.fn()}
        sets={sets}
        selectedSets={[]}
        onSets={onSets}
        onHome={vi.fn()}
        tileSize={300}
        onTileSize={vi.fn()}
        selectedFolderId={null}
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onRescan={vi.fn()}
        onRetryFailed={vi.fn()}
        onImportRatings={vi.fn()}
        exclusions={[]}
        onInclude={vi.fn()}
      />,
    )
    expect(screen.getByText('aqua (konosuba)')).toBeTruthy()
    expect(screen.queryByText('mira')).toBeNull()
    fireEvent.click(heading(/^Sets/))
    expect(screen.queryByText('aqua (konosuba)')).toBeNull()
    unmount()

    // Remounted with no characters detected: the remembered list is Sets, and it is there.
    render(sidebar())
    expect(heading(/^Sets/).getAttribute('aria-expanded')).toBe('true')
  })

  it('offers each section only when it has something behind it', () => {
    // A section that opens onto an empty list reads as broken; the sidebar already
    // hid Sets for a library that had never been shot in, and LoRA sets follows it.
    const { unmount } = render(sidebar(sets.slice(0, 2)))
    expect(screen.getByRole('button', { name: /^LoRA sets/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Sets/ })).toBeNull()
    unmount()

    render(sidebar(sets.slice(2)))
    expect(screen.getByRole('button', { name: /^Sets/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^LoRA sets/ })).toBeNull()
  })

  it('remembers a folded section across a remount', () => {
    const { unmount } = render(sidebar())
    fireEvent.click(heading(/^Sets/))
    expect(screen.queryByText('mira')).toBeNull()
    unmount()

    render(sidebar())
    expect(heading(/^Sets/).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('mira')).toBeNull()
  })

  it('opens a folded section when the selected set lives inside it', () => {
    // A deep link into a training round must not land on a folded heading.
    render(sidebar(sets, { selectedSets: ['lora-ari-r1-1'] }))
    expect(heading(/^LoRA sets/).getAttribute('aria-expanded')).toBe('true')
    // Both rounds are rows named by their command; the selected one is the pressed one.
    const rows = screen.getAllByRole('button', { name: /^lora/ })
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
  })

  // Two shoots of one character are read — and posted — as one set. A plain
  // click stays a plain click, so this list does not quietly accumulate; the
  // modifier is what says "as well as", the same as in the grid.
  it('adds a second set on a modified click and replaces on a plain one', () => {
    render(sidebar())
    const shotall = screen.getByRole('button', { name: /shotall/ })
    const story = screen.getByRole('button', { name: /photostory/ })

    shotall.click()
    expect(onSets).toHaveBeenLastCalledWith(['shotall-mira-1'])

    story.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(onSets).toHaveBeenLastCalledWith(['photostory-mira-1'])
  })

  it('reports both when one is already showing and the other is ctrl-clicked', () => {
    render(sidebar(sets, { selectedSets: ['shotall-mira-1'] }))
    screen
      .getByRole('button', { name: /photostory/ })
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(onSets).toHaveBeenLastCalledWith(['shotall-mira-1', 'photostory-mira-1'])
    // Selection order is what the merge tie-breaks on, so it must survive.
    expect(screen.getByRole('button', { name: /shotall/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('makes the wordmark a way back to everything', () => {
    // On a phone the sidebar is a drawer, and once a set is filtering the grid
    // there is no other obvious "show me everything" — a dead wordmark is a
    // dead end there.
    const onHome = vi.fn()
    render(sidebar(sets, { onHome }))
    screen.getByRole('button', { name: 'Luma Vault' }).click()
    expect(onHome).toHaveBeenCalledOnce()
  })
})
