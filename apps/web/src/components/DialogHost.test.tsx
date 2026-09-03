import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  /**
   * How iOS Safari delivers a tap: pointer events at touch time, then — after
   * the toolbar has toggled and the viewport has resized — mousedown, mouseup
   * and click, dispatched to whatever is under the *original* point. For a
   * dialog that moved with the viewport that was the backdrop, and the old
   * backdrop `onMouseDown` read the tap that meant "yes" as a click-away. Only
   * on an iPhone: an iPad's toolbar is at the top and does not move.
   */
  describe('a phone tap that Safari finishes late', () => {
    // jsdom has no PointerEvent, so one is shaped by hand with the two fields
    // the dialog reads: which pointer, and what kind.
    const fireTouch = (target: Element, type: 'pointerdown' | 'pointerup' | 'pointercancel') => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      Object.defineProperty(event, 'pointerType', { value: 'touch' })
      fireEvent(target, event)
    }
    it('answers on the finger lifting, even when the mouse events then hit the backdrop', async () => {
      render(<DialogHost />)
      const asked = askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' })
      await settle()

      const confirm = screen.getByRole('button', { name: 'Delete' })
      const backdrop = screen.getByRole('alertdialog').parentElement!
      fireTouch(confirm, 'pointerdown')
      fireTouch(confirm, 'pointerup')
      // The viewport shifted; Safari's late compatibility events land beside
      // the box that moved.
      fireEvent.mouseDown(backdrop)
      fireEvent.mouseUp(backdrop)
      fireEvent.click(backdrop)

      expect(await asked).toBe(true)
    })

    it('answers a tap exactly once, though the tap arrives as pointerup and click both', async () => {
      const onAnswer = vi.fn()
      render(<DialogHost />)
      void askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' }).then(onAnswer)
      await settle()

      const confirm = screen.getByRole('button', { name: 'Delete' })
      fireTouch(confirm, 'pointerdown')
      fireTouch(confirm, 'pointerup')
      fireEvent.click(confirm)
      await settle()

      expect(onAnswer).toHaveBeenCalledTimes(1)
      expect(onAnswer).toHaveBeenCalledWith(true)
    })

    it('still cancels on a tap that lands and lifts on the backdrop', async () => {
      render(<DialogHost />)
      const asked = askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' })
      await settle()

      const backdrop = screen.getByRole('alertdialog').parentElement!
      fireTouch(backdrop, 'pointerdown')
      fireTouch(backdrop, 'pointerup')

      expect(await asked).toBe(false)
    })

    it('ignores a press that starts on the panel and is dragged out to the backdrop', async () => {
      render(<DialogHost />)
      const asked = askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' })
      await settle()

      const backdrop = screen.getByRole('alertdialog').parentElement!
      fireTouch(screen.getByText('Delete holiday.jpg?'), 'pointerdown')
      fireTouch(backdrop, 'pointerup')
      fireEvent.click(backdrop)
      await settle()

      // Neither answered nor gone: the question is still on screen.
      expect(screen.getByRole('alertdialog')).toBeTruthy()
      screen.getByRole('button', { name: 'Cancel' }).click()
      expect(await asked).toBe(false)
    })

    it('ignores a bare click on the backdrop that no pointer put there', async () => {
      // Exactly the stray event the phone sends. On its own it must do nothing.
      render(<DialogHost />)
      const asked = askConfirm('Delete holiday.jpg?', { confirmLabel: 'Delete' })
      await settle()

      const backdrop = screen.getByRole('alertdialog').parentElement!
      fireEvent.mouseDown(backdrop)
      fireEvent.click(backdrop)
      await settle()

      expect(screen.getByRole('alertdialog')).toBeTruthy()
      screen.getByRole('button', { name: 'Delete' }).click()
      expect(await asked).toBe(true)
    })
  })
})
