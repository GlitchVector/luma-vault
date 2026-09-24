import { CUSTOM_LORAS, type CustomCharacter } from '@luma/core'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CharactersPanel } from '#/components/CharactersPanel.tsx'

// Auto-cleanup is off in this suite, so a page left mounted would answer the next test's clicks.
afterEach(cleanup)

const customCharacters = vi.hoisted(() => vi.fn())
const saveCustomCharacter = vi.hoisted(() => vi.fn())
const removeCustomCharacter = vi.hoisted(() => vi.fn())
const queryMedia = vi.hoisted(() => vi.fn())
vi.mock('#/lib/native.ts', () => ({
  customCharacters,
  saveCustomCharacter,
  removeCustomCharacter,
  queryMedia,
  loraDataset: vi.fn(),
  loraImagePreview: vi.fn(),
  fileUrl: (path: string) => `luma://${path}`,
}))
afterEach(() => {
  customCharacters.mockReset()
  saveCustomCharacter.mockReset()
  removeCustomCharacter.mockReset()
  queryMedia.mockReset()
})

// The catalogue's current Ari line and one of its outfits: the tests read them rather than hard-coding
// names, so a version bump of the catalogue does not break the page's tests.
const main = CUSTOM_LORAS.find((entry) => entry.kind === 'full' && CUSTOM_LORAS.some((other) => other.parent === entry.name))!
const outfit = CUSTOM_LORAS.find((entry) => entry.parent === main.name)!

function ari(overrides: Partial<CustomCharacter> = {}): CustomCharacter {
  return {
    id: 'ari',
    name: 'Ari',
    description: 'White bob, teal top.',
    defaultLora: main.name,
    loras: [outfit.name],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function open(characters: CustomCharacter[]) {
  customCharacters.mockResolvedValue(characters)
  queryMedia.mockResolvedValue({ items: [], total: 0, offset: 0 })
  return render(<CharactersPanel onClose={() => undefined} onShowRenders={() => undefined} />)
}

describe('the Characters page', () => {
  it('says there are none yet rather than showing an empty grid', async () => {
    open([])
    expect(await screen.findByTestId('characters-empty')).toBeTruthy()
  })

  it('creates a character from the form: a name, a description and a default LoRA', async () => {
    open([])
    await screen.findByTestId('characters-empty')
    fireEvent.click(screen.getByRole('button', { name: '+ New character' }))
    const form = screen.getByTestId('character-form')
    const create = within(form).getByRole('button', { name: 'Create' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)

    fireEvent.change(within(form).getByPlaceholderText('e.g. Ari'), { target: { value: 'Ari' } })
    fireEvent.change(within(form).getByPlaceholderText('Who she is, in a sentence or two'), { target: { value: 'White bob.' } })
    fireEvent.change(within(form).getByRole('combobox'), { target: { value: main.name } })
    saveCustomCharacter.mockResolvedValue(ari({ loras: [] }))
    fireEvent.click(create)

    await waitFor(() => expect(screen.getByTestId('character-card')).toBeTruthy())
    expect(saveCustomCharacter).toHaveBeenCalledWith({ id: null, name: 'Ari', description: 'White bob.', defaultLora: main.name, loras: [] })
  })

  it('lists her default LoRA first and her other LoRAs under it', async () => {
    open([ari()])
    const card = await screen.findByTestId('character-card')
    const rows = within(card).getAllByTestId('character-lora')
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining(main.name), expect.stringContaining(outfit.name)])
    expect(within(rows[0]!).getByText('default')).toBeTruthy()
  })

  it('opens a LoRA in the side panel with its details, and Escape closes the panel before the page', async () => {
    const onClose = vi.fn()
    customCharacters.mockResolvedValue([ari()])
    queryMedia.mockResolvedValue({ items: [], total: 0, offset: 0 })
    render(<CharactersPanel onClose={onClose} onShowRenders={() => undefined} />)
    const card = await screen.findByTestId('character-card')
    fireEvent.click(within(card).getAllByTestId('character-lora')[1]!.querySelector('button')!)

    const panel = screen.getByTestId('lora-side-panel')
    expect(within(panel).getByText(outfit.description)).toBeTruthy()
    expect(within(panel).getByText(`<lora:${outfit.name}:${outfit.weight ?? 1}>`)).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('lora-side-panel')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('follows a superseded LoRA file to the one that replaced it', async () => {
    const older = CUSTOM_LORAS.find((entry) => entry.olderVersions.length > 0)!
    open([ari({ defaultLora: older.olderVersions[0]!, loras: [] })])
    const card = await screen.findByTestId('character-card')
    expect(within(card).getByTestId('character-lora').textContent).toContain(older.name)
  })

  it('says so when a LoRA she names is not in the catalogue any more', async () => {
    open([ari({ loras: ['gone_v1'] })])
    const card = await screen.findByTestId('character-card')
    fireEvent.click(within(card).getAllByTestId('character-lora')[1]!.querySelector('button')!)
    expect(within(screen.getByTestId('lora-side-panel')).getByText(/not in the LoRA catalogue any more/)).toBeTruthy()
  })

  it('adds another LoRA to her card, offering the default LoRA\'s own outfits first', async () => {
    open([ari({ loras: [] })])
    const card = await screen.findByTestId('character-card')
    fireEvent.click(within(card).getByRole('button', { name: /Add a LoRA/ }))
    const picker = within(card).getByTestId('add-lora')
    const groups = within(picker).getByRole('combobox').querySelectorAll('optgroup')
    expect(groups[0]!.getAttribute('label')).toBe(`Outfits and variants of ${main.name}`)
    expect(groups[0]!.textContent).toContain(outfit.name)

    saveCustomCharacter.mockResolvedValue(ari())
    fireEvent.change(within(picker).getByRole('combobox'), { target: { value: outfit.name } })
    fireEvent.click(within(picker).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(within(card).getAllByTestId('character-lora')).toHaveLength(2))
    expect(saveCustomCharacter).toHaveBeenCalledWith(expect.objectContaining({ id: 'ari', loras: [outfit.name] }))
  })

  it('removes a card only after a second click', async () => {
    open([ari()])
    const card = await screen.findByTestId('character-card')
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }))
    expect(removeCustomCharacter).not.toHaveBeenCalled()
    removeCustomCharacter.mockResolvedValue(true)
    fireEvent.click(within(card).getByRole('button', { name: 'Remove her' }))
    await waitFor(() => expect(screen.queryByTestId('character-card')).toBeNull())
    expect(removeCustomCharacter).toHaveBeenCalledWith('ari')
  })
})
