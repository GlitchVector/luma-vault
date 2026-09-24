/**
 * The conversation view on its own: what the Comics panel relies on when it
 * drops the view into its first step with a message already typed.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  chatFeed: vi.fn(),
  chatStart: vi.fn(),
  chatSend: vi.fn(),
  chatStop: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('#/lib/native.ts', () => native)

import { ChatView } from './ChatView.tsx'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ChatView', () => {
  it('starts a new conversation from the prefilled draft, with its topic, on one Enter', async () => {
    native.chatStart.mockResolvedValue({ id: 's1', title: '/comic first-light', status: 'running', model: null, topic: 'comic:first-light', createdAt: 1, lastActivityAt: 1, turns: 0 })
    native.chatFeed.mockResolvedValue({ session: { id: 's1', title: '/comic first-light', status: 'done', model: null, topic: 'comic:first-light', createdAt: 1, lastActivityAt: 2, turns: 1 }, events: [], next: 0 })
    const onSession = vi.fn()
    render(<ChatView sessionId={null} onSession={onSession} initialDraft="/comic first-light" topic="comic:first-light" available />)
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement
    expect(input.value).toBe('/comic first-light')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(native.chatStart).toHaveBeenCalledWith('/comic first-light', null, 'comic:first-light'))
    await waitFor(() => expect(onSession).toHaveBeenCalledWith('s1'))
  })

  it('keeps the composer shut while the CLI is missing, and shows the empty state before the first message', () => {
    render(<ChatView sessionId={null} initialDraft="hello" available={false} empty={<p>nothing yet</p>} />)
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText('nothing yet')).toBeTruthy()
  })
})
