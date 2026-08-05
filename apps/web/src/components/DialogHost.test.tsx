import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { askConfirm, resetDialogs, showMessage } from '#/lib/dialogs.ts'
import { DialogHost } from './DialogHost.tsx'

/**
 * These stand in for the thing that went wrong: Delete called `window.confirm`,
 * got `undefined` back, and silently did nothing — no dialog, no error, no way
 * to tell from the outside. Nothing in the suite could have caught it, because
 * the dialog was not the app's to render. Now it is, so it is testable.
 */

afterEach(() => {
  resetDialogs()
  cleanup()
})

/** Lets React flush the store update the promise callbacks caused. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('DialogHost', () => {
  it('shows nothing until something asks', () => {
    render(<DialogHost />)
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('resolves true when confirmed and false when cancelled', async () => {
    render(<DialogHost />)

    const first = askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' })
    await settle()
    screen.getByRole('button', { name: 'Delete' }).click()
    expect(await first).toBe(true)

    const second = askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' })
    await settle()
    screen.getByRole('button', { name: 'Cancel' }).click()
    expect(await second).toBe(false)
  })

  it('closes before the answer runs, so an action never sees its own dialog', async () => {
    render(<DialogHost />)
    const answered = askConfirm('go?').then(() => screen.queryByRole('alertdialog'))
    await settle()
    screen.getByRole('button', { name: 'Confirm' }).click()
    expect(await answered).toBeNull()
  })

  it('offers no cancel for a notice, because there is nothing to decline', async () => {
    render(<DialogHost />)
    const shown = showMessage('Removed 812 files from the library.')
    await settle()

    expect(screen.getByText('Removed 812 files from the library.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
    screen.getByRole('button', { name: 'OK' }).click()
    await expect(shown).resolves.toBeUndefined()
  })

  it('takes Escape as a cancel and Enter as a confirm', async () => {
    render(<DialogHost />)

    const escaped = askConfirm('go?')
    await settle()
    press('Escape')
    expect(await escaped).toBe(false)

    const entered = askConfirm('go?')
    await settle()
    press('Enter')
    expect(await entered).toBe(true)
  })

  it('keeps its keystrokes away from whatever is behind it', async () => {
    // The lightbox listens on `window` for Escape and the arrows. With a
    // confirm open, Escape must answer the question and *not* also close the
    // file underneath — and an arrow key must not step to the next file, which
    // would leave the dialog asking about one file and the answer landing on
    // another.
    const behind = vi.fn()
    window.addEventListener('keydown', behind)

    render(<DialogHost />)
    const asked = askConfirm('Delete holiday.jpg?')
    await settle()

    press('Escape')
    press('ArrowRight')
    expect(behind).not.toHaveBeenCalled()
    expect(await asked).toBe(false)

    // ...and once it is answered, the app gets its keyboard back.
    await settle()
    press('ArrowRight')
    expect(behind).toHaveBeenCalledTimes(1)

    window.removeEventListener('keydown', behind)
  })

  it('queues, so a background result cannot replace the question on screen', async () => {
    render(<DialogHost />)

    const first = askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' })
    const second = showMessage('Scan finished.')
    await settle()

    expect(screen.getByText('Delete holiday.jpg?')).toBeTruthy()
    expect(screen.queryByText('Scan finished.')).toBeNull()

    screen.getByRole('button', { name: 'Delete' }).click()
    expect(await first).toBe(true)
    await settle()

    expect(screen.getByText('Scan finished.')).toBeTruthy()
    screen.getByRole('button', { name: 'OK' }).click()
    await second
  })
})
