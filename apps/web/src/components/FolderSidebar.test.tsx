import type { SetSummary } from '@luma/core'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FolderSidebar, LORA_COMMAND, type Listing } from './FolderSidebar.tsx'

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

function sidebar(listing: Listing, given: SetSummary[] = sets) {
  return (
    <FolderSidebar
      folders={[]}
      stats={null}
      characters={[]}
      onCharacter={vi.fn()}
      sets={given}
      listing={listing}
      onListing={vi.fn()}
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
    />
  )
}

afterEach(() => {
  cleanup()
  onSets.mockReset()
})

describe('FolderSidebar set lists', () => {
  it('lists only the training rounds under LoRA', () => {
    render(sidebar('lora'))
    expect(screen.getByText('ari-r1')).toBeTruthy()
    expect(screen.getByText('rati-r1')).toBeTruthy()
    expect(screen.queryByText('mira')).toBeNull()
  })

  it('keeps the training rounds out of Sets', () => {
    render(sidebar('sets'))
    expect(screen.getByText('mira')).toBeTruthy()
    expect(screen.queryByText('ari-r1')).toBeNull()
    expect(screen.queryByText('rati-r1')).toBeNull()
  })

  it('offers each tab only when it has something behind it', () => {
    // A tab that opens onto an empty list reads as broken; the sidebar already
    // hid Sets for a library that had never been shot in, and LoRA follows it.
    const { unmount } = render(sidebar('characters', sets.slice(0, 2)))
    expect(screen.getByRole('button', { name: 'LoRA' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sets' })).toBeNull()
    unmount()

    render(sidebar('characters', sets.slice(2)))
    expect(screen.getByRole('button', { name: 'Sets' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'LoRA' })).toBeNull()
  })

  // Two shoots of one character are read — and posted — as one set. A plain
  // click stays a plain click, so this list does not quietly accumulate; the
  // modifier is what says "as well as", the same as in the grid.
  it('adds a second set on a modified click and replaces on a plain one', () => {
    render(sidebar('sets'))
    const shotall = screen.getByRole('button', { name: /shotall/ })
    const story = screen.getByRole('button', { name: /photostory/ })

    shotall.click()
    expect(onSets).toHaveBeenLastCalledWith(['shotall-mira-1'])

    story.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(onSets).toHaveBeenLastCalledWith(['photostory-mira-1'])
  })

  it('reports both when one is already showing and the other is ctrl-clicked', () => {
    const { rerender } = render(sidebar('sets'))
    rerender(
      <FolderSidebar
        folders={[]}
        stats={null}
        characters={[]}
        onCharacter={vi.fn()}
        sets={sets}
        listing="sets"
        onListing={vi.fn()}
        selectedSets={['shotall-mira-1']}
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
    render(
      <FolderSidebar
        folders={[]}
        stats={null}
        characters={[]}
        onCharacter={vi.fn()}
        sets={sets}
        listing="sets"
        onListing={vi.fn()}
        selectedSets={[]}
        onSets={vi.fn()}
        onHome={onHome}
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
    screen.getByRole('button', { name: 'Luma Vault' }).click()
    expect(onHome).toHaveBeenCalledOnce()
  })
})
