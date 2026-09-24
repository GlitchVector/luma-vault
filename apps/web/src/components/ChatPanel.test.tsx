/**
 * The Chat panel's pure parts: the words the feed puts on a tool call and on
 * a result, separated from the markup — plus the two states the page opens
 * in, which are what a person sees first.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@luma/core'

const native = vi.hoisted(() => ({
  chatIndex: vi.fn(),
  chatFeed: vi.fn(),
  chatStart: vi.fn(),
  chatSend: vi.fn(),
  chatStop: vi.fn(),
  chatRemove: vi.fn(),
  openExternal: vi.fn(),
}))
vi.mock('#/lib/native.ts', () => native)

import { ChatPanel, formatDuration, resultText, statusTone, toolLabel } from './ChatPanel.tsx'

function event(partial: Partial<ChatEvent>): ChatEvent {
  return {
    seq: 0,
    at: 0,
    kind: 'result',
    text: null,
    name: null,
    detail: null,
    success: null,
    stopped: null,
    durationMs: null,
    costUsd: null,
    ...partial,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('toolLabel', () => {
  it('reads as an action, not a tool name', () => {
    expect(toolLabel('Edit', 'src/a.rs')).toBe('Editing src/a.rs')
    expect(toolLabel('Read', 'CLAUDE.md')).toBe('Reading CLAUDE.md')
    expect(toolLabel('Grep', 'fn main')).toBe('Searching fn main')
    expect(toolLabel('Bash', 'Run the tests')).toBe('Run the tests')
    expect(toolLabel('Bash', '')).toBe('Running a command')
    expect(toolLabel('Skill', 'lora')).toBe('Following /lora')
    expect(toolLabel('mcp__design-app__list_frames', '')).toBe('Calling list_frames')
    expect(toolLabel('Whatever', 'x')).toBe('Whatever x')
  })
})

describe('resultText', () => {
  it('says how the turn ended and what it took', () => {
    expect(resultText(event({ success: true, durationMs: 4200, costUsd: 0.0132 }))).toBe('Done in 4s · $0.013')
    expect(resultText(event({ success: true, durationMs: 800, costUsd: 0 }))).toBe('Done in 800ms')
    expect(resultText(event({ success: false, durationMs: 65000 }))).toBe('Failed after 1m 5s')
    expect(resultText(event({ success: false, stopped: true, durationMs: 3000 }))).toBe('Stopped after 3s')
  })

  it('formats durations the way a person reads them', () => {
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(59_400)).toBe('59s')
    expect(formatDuration(125_000)).toBe('2m 5s')
  })
})

describe('statusTone', () => {
  it('pulses while running and settles by outcome', () => {
    expect(statusTone('running')).toContain('animate-pulse')
    expect(statusTone('failed')).toContain('red')
    expect(statusTone('done')).toContain('emerald')
    expect(statusTone('idle')).toContain('zinc')
  })
})

describe('ChatPanel', () => {
  it('explains the install step when the CLI is not there, and keeps the composer disabled', async () => {
    native.chatIndex.mockResolvedValue({ available: false, cwd: 'D:/repo', sessions: [] })
    render(<ChatPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/not installed/)).toBeTruthy())
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(true)
    expect(native.chatFeed).not.toHaveBeenCalled()
  })

  it('opens on a new conversation with the list of old ones, and offers a model only before the first turn', async () => {
    native.chatIndex.mockResolvedValue({
      available: true,
      cwd: 'D:/repo',
      sessions: [
        { id: 'a', title: 'Why does the grid reflow?', status: 'done', model: null, createdAt: 1, lastActivityAt: 2, turns: 1 },
      ],
    })
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    render(<ChatPanel onClose={vi.fn()} listInto={slot} />)
    await waitFor(() => expect(slot.textContent).toContain('Why does the grid reflow?'))
    expect(screen.getByText(/Ask Claude Code about the vault/)).toBeTruthy()
    expect(screen.getByLabelText('Model')).toBeTruthy()
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).disabled).toBe(false)
    slot.remove()
  })
})
