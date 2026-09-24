import { Button, EmptyState, cn } from '@luma/ui'
import type { ChatIndex } from '@luma/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { chatIndex, chatRemove, openExternal } from '#/lib/native.ts'
import { askConfirm, showMessage } from '#/lib/dialogs.ts'
import { ChatView } from '#/components/ChatView.tsx'

export { formatDuration, resultText, toolLabel } from '#/components/ChatView.tsx'

/**
 * The Chat page: every conversation with Claude Code, one open at a time.
 *
 * The shape is Diorama's: every message is one `claude -p` turn on the Rust
 * side; `ChatView` draws the feed those turns produce, and this page only
 * decides which conversation it shows. The list of conversations renders
 * into the sidebar by portal, like the comics list, so the sidebar stays the
 * way back to the grid.
 */

interface ChatPanelProps {
  onClose: () => void
  /** On a phone the sidebar is a drawer; this opens it, since the filter bar that usually does is not on this page. */
  onOpenLibrary?: () => void
  /**
   * Where the list of conversations renders: the Conversations section the
   * main sidebar shows while this page is open. `null` while the section is
   * folded, and the list simply does not render.
   */
  listInto?: HTMLElement | null
}

/** The list entry's dot: what the conversation is doing right now. */
export function statusTone(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-indigo-400 animate-pulse'
    case 'failed':
      return 'bg-red-400'
    case 'done':
      return 'bg-emerald-400'
    default:
      return 'bg-zinc-600'
  }
}

export function ChatPanel({ onOpenLibrary, listInto }: ChatPanelProps) {
  const [index, setIndex] = useState<ChatIndex | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const live = useRef(true)

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const reloadIndex = useCallback(async () => {
    try {
      const fresh = await chatIndex()
      if (live.current) setIndex(fresh)
    } catch (error) {
      if (live.current) void showMessage(String(error), { title: 'Chat' })
    }
  }, [])

  useEffect(() => {
    void reloadIndex()
  }, [reloadIndex])

  const onSession = useCallback(
    (id: string | null) => {
      setOpenId(id)
      void reloadIndex()
    },
    [reloadIndex],
  )

  const remove = useCallback(
    async (id: string) => {
      const entry = index?.sessions.find((s) => s.id === id)
      const ok = await askConfirm(`Forget "${entry?.title ?? 'this conversation'}"?`, {
        title: 'Chat',
        confirmLabel: 'Forget',
      })
      if (!ok) return
      await chatRemove(id)
      if (openId === id) setOpenId(null)
      void reloadIndex()
    },
    [index, openId, reloadIndex],
  )

  const session = index?.sessions.find((s) => s.id === openId) ?? null
  const available = index === null ? null : index.available

  const list = (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setOpenId(null)}
        className={cn('rounded px-2 py-1 text-left text-xs hover:bg-white/5', openId === null ? 'bg-white/10 text-zinc-100' : 'text-zinc-400')}
      >
        + New conversation
      </button>
      {(index?.sessions ?? []).map((entry) => (
        <div key={entry.id} className="group flex items-center gap-1">
          <button
            type="button"
            onClick={() => setOpenId(entry.id)}
            title={entry.topic ? `${entry.title} (${entry.topic})` : entry.title}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-white/5',
              openId === entry.id ? 'bg-white/10 text-zinc-100' : 'text-zinc-400',
            )}
          >
            <span className={cn('size-1.5 shrink-0 rounded-full', statusTone(entry.status))} aria-hidden />
            <span className="truncate">{entry.title}</span>
          </button>
          <button
            type="button"
            aria-label={`Forget ${entry.title}`}
            onClick={() => void remove(entry.id)}
            className="shrink-0 rounded px-1 text-zinc-600 opacity-0 hover:text-red-300 group-hover:opacity-100 focus:opacity-100"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-950 text-zinc-200">
      {listInto ? createPortal(list, listInto) : null}
      <header className="flex items-center gap-4 border-b border-white/10 bg-zinc-900/50 px-4 py-2">
        <div className="flex shrink-0 items-center gap-2">
          {onOpenLibrary ? (
            <Button size="sm" onClick={onOpenLibrary} aria-label="Open the library panel" className="md:hidden">
              Library
            </Button>
          ) : null}
          <span className="text-sm font-semibold">Chat</span>
        </div>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-500" title={index?.cwd}>
          {session ? session.title : index?.cwd ? `Claude Code, in ${index.cwd}` : ''}
        </span>
        {session?.model ? <span className="text-xs text-zinc-500">{session.model}</span> : null}
      </header>

      {index !== null && !index.available ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            title="Claude Code is not installed on the machine with the library"
            hint={`Install it from claude.com/claude-code, sign in once with \`claude\` in a terminal, and restart the app. Conversations run in ${index.cwd || 'the repository'}.`}
            action={
              <Button size="sm" onClick={() => void openExternal('https://claude.com/claude-code')}>
                Open the install page
              </Button>
            }
          />
        </div>
      ) : null}

      <ChatView
        sessionId={openId}
        onSession={onSession}
        available={available}
        showModelPicker
        empty={
          <EmptyState
            title="Ask Claude Code about the vault"
            hint="It runs in the repository with the same notes and skills a terminal session has, so it can explain how something works, change it, or look at a set. Every message is one turn; the conversation is kept and resumes."
          />
        }
      />
    </div>
  )
}
