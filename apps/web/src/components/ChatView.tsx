import { Button, Spinner, cn } from '@luma/ui'
import type { ChatEvent, ChatSessionInfo } from '@luma/core'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { chatFeed, chatSend, chatStart, chatStop, openExternal } from '#/lib/native.ts'
import { showMessage } from '#/lib/dialogs.ts'
import { toast } from '#/lib/toasts.ts'

/**
 * One conversation with Claude Code: the feed and the composer, nothing about
 * which conversation. The Chat page wraps it with a list; the Comics panel
 * drops it into its first step with `/story <name>` already typed. Every
 * message is one `claude -p` turn on the Rust side; this only draws the feed
 * those turns produce and polls it with the sequence number it has.
 */

export interface ChatViewProps {
  /** The conversation to show, or null for one that starts with the first message. */
  sessionId: string | null
  /** A conversation was started here (or the person asked for a new one). */
  onSession?: (id: string | null) => void
  /** What the composer holds before the person types; sent with one Enter. */
  initialDraft?: string
  /** For a new conversation: what it is about, so it can be found again (`comic:<name>`). */
  topic?: string | null
  /** The CLI's model alias for a new conversation; null for its default. */
  model?: string | null
  /** Offer the model picker before the first turn. */
  showModelPicker?: boolean
  /** Whether the CLI is there; null while unknown. */
  available: boolean | null
  /** What the feed shows before the first message. */
  empty?: ReactNode
  /** A turn ended, with the session as it stands. */
  onTurnEnd?: (info: ChatSessionInfo) => void
  className?: string
}

const POLL_MS = 1000
/** ~8 lines, then the composer scrolls. */
const MAX_INPUT_HEIGHT = 160
/** How close to the bottom still counts as following along. */
const STICK_ZONE = 40

/** The CLI's own aliases. Empty is its default. */
export const MODELS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Default model' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

/**
 * How the answer's markdown is drawn. Module-level, so a poll that adds a row
 * does not hand every row a fresh set of element types. Links open outside:
 * in-page navigation would replace the app.
 */
const MARKDOWN: Components = {
  a: ({ href, children }) => (
    <button type="button" className="text-indigo-300 underline" onClick={() => href && void openExternal(href)}>
      {children}
    </button>
  ),
  pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md bg-black/40 p-2 text-xs">{children}</pre>,
  code: ({ children, className }) =>
    className ? <code className={className}>{children}</code> : <code className="rounded bg-white/10 px-1 text-[0.9em]">{children}</code>,
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1 text-base font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-semibold">{children}</h4>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-white/10 px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b border-white/5 px-2 py-1 align-top">{children}</td>,
}

const inputClass =
  'w-full rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-indigo-400'
const selectClass =
  'rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-indigo-400'

/**
 * "Editing", "Reading", "Running" — the person reads actions, not tool
 * names. Claude names its tools in PascalCase; MCP tools arrive as
 * `mcp__server__tool` and are shown by their last part.
 */
export function toolLabel(name: string, detail: string): string {
  const short = detail ? ` ${detail}` : ''
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return `Editing${short}`
  if (/^Read$/.test(name)) return `Reading${short}`
  if (/^(Grep|Glob)$/.test(name)) return `Searching${short}`
  if (/^(WebSearch|WebFetch)$/.test(name)) return `Looking up${short}`
  if (/^(Bash|PowerShell)$/.test(name)) return detail || 'Running a command'
  if (/^(TodoWrite|TaskCreate|TaskUpdate)$/.test(name)) return 'Planning the steps'
  if (/^(Task|Agent)$/.test(name)) return `Delegating${short}`
  if (/^Skill$/.test(name)) return `Following${short ? ` /${detail}` : ' a skill'}`
  if (name.startsWith('mcp__')) return `Calling ${name.split('__').pop() ?? name}${short}`
  return `${name}${short}`
}

/** The result banner's words, from how the turn ended. */
export function resultText(event: ChatEvent): string {
  const took = event.durationMs !== null && event.durationMs !== undefined ? ` in ${formatDuration(event.durationMs)}` : ''
  const cost = event.costUsd !== null && event.costUsd !== undefined && event.costUsd > 0 ? ` · $${event.costUsd.toFixed(3)}` : ''
  if (event.stopped) return `Stopped${took.replace(' in ', ' after ')}`
  if (event.success) return `Done${took}${cost}`
  return `Failed${took.replace(' in ', ' after ')}${cost}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function ChatView({
  sessionId,
  onSession,
  initialDraft = '',
  topic = null,
  model: fixedModel = null,
  showModelPicker = false,
  available,
  empty,
  onTurnEnd,
  className,
}: ChatViewProps) {
  const [session, setSession] = useState<ChatSessionInfo | null>(null)
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [draft, setDraft] = useState(sessionId ? '' : initialDraft)
  const [model, setModel] = useState(fixedModel ?? '')
  const [sending, setSending] = useState(false)
  const [showLog, setShowLog] = useState(false)
  /** The sequence number the next poll asks from. */
  const next = useRef(0)
  const live = useRef(true)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const turnEnd = useRef(onTurnEnd)
  turnEnd.current = onTurnEnd

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  // A new conversation gets the prefilled draft; an existing one starts empty.
  useEffect(() => {
    setDraft(sessionId ? '' : initialDraft)
    // The draft is what the person sends with one Enter, so it wants the caret.
    if (!sessionId && initialDraft) inputRef.current?.focus()
  }, [sessionId, initialDraft])

  // Opening a conversation: the whole feed, then follow it while it runs.
  useEffect(() => {
    if (!sessionId) {
      setSession(null)
      setEvents([])
      next.current = 0
      return
    }
    let stopped = false
    pinned.current = true
    next.current = 0
    setEvents([])
    let wasRunning: boolean | null = null
    const tick = async () => {
      let feed
      try {
        feed = await chatFeed(sessionId, next.current)
      } catch (error) {
        if (!stopped && live.current) {
          void showMessage(String(error), { title: 'Chat' })
          onSession?.(null)
        }
        return
      }
      if (stopped || !live.current) return
      if (feed.events.length > 0) {
        setEvents((previous) => (next.current === 0 ? feed.events : [...previous, ...feed.events]))
        next.current = feed.next
      }
      setSession((previous) => {
        // A no-op poll must not re-render the composer under the person.
        if (previous && JSON.stringify(previous) === JSON.stringify(feed.session)) return previous
        return feed.session
      })
      const running = feed.session.status === 'running'
      if (wasRunning === true && !running) turnEnd.current?.(feed.session)
      wasRunning = running
      return feed.session.status
    }
    let timer: ReturnType<typeof setInterval> | null = null
    void tick().then((status) => {
      if (stopped) return
      timer = setInterval(() => {
        void tick().then((now) => {
          // Keep polling until the turn has ended; then one last read is enough.
          if (now && now !== 'running' && timer) {
            clearInterval(timer)
            timer = null
          }
        })
      }, POLL_MS)
      if (status !== 'running' && timer) {
        clearInterval(timer)
        timer = null
      }
    })
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
    }
    // `sending` restarts the poll after a message, which is when the turn begins.
  }, [sessionId, sending, onSession])

  // Follow the feed unless the reader scrolled up to read something.
  useEffect(() => {
    const feed = feedRef.current
    if (feed && pinned.current) feed.scrollTop = feed.scrollHeight
  }, [events, session?.status])

  // One line empty, growing with the content up to the max, then scrolling.
  useLayoutEffect(() => {
    const input = inputRef.current
    if (input) {
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`
    }
  }, [draft])

  const running = session?.status === 'running'
  const ready = available === true

  const send = useCallback(async () => {
    const message = draft.trim()
    if (!message || sending || running || !ready) return
    setSending(true)
    try {
      if (sessionId) {
        const info = await chatSend(sessionId, message)
        setSession(info)
      } else {
        const info = await chatStart(message, model || null, topic)
        setSession(info)
        onSession?.(info.id)
      }
      setDraft('')
      pinned.current = true
    } catch (error) {
      void showMessage(String(error), { title: 'Chat' })
    } finally {
      if (live.current) setSending(false)
    }
  }, [draft, sending, running, ready, sessionId, model, topic, onSession])

  const stop = useCallback(() => {
    if (!sessionId) return
    void chatStop(sessionId).then((did) => {
      if (did) toast('stopped')
    })
  }, [sessionId])

  // Escape stops the running turn, from anywhere on the page.
  useEffect(() => {
    if (!running) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        stop()
      }
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [running, stop])

  const stderr = events.filter((event) => event.kind === 'stderr')
  const shown = events.filter((event) => event.kind !== 'stderr')

  const placeholder =
    available === null
      ? 'Looking for Claude Code…'
      : !available
        ? 'Install Claude Code to chat'
        : running
          ? 'Still working — Esc to stop, or wait'
          : sessionId
            ? 'Reply…'
            : 'Ask, or describe a change…'

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={feedRef}
        onScroll={(event) => {
          const feed = event.currentTarget
          pinned.current = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - STICK_ZONE
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        data-testid="chat-feed"
      >
        {!sessionId ? (
          empty
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {shown.map((event) => (
              <EventRow key={event.seq} event={event} />
            ))}
            {running ? (
              <div className="flex items-center gap-2 py-1 text-xs text-zinc-500">
                <Spinner />
                working…
              </div>
            ) : null}
            {stderr.length > 0 ? (
              <div className="pt-2">
                <button type="button" onClick={() => setShowLog((previous) => !previous)} className="text-xs text-zinc-500 hover:text-zinc-300">
                  {showLog ? 'Hide log' : `Show log (${stderr.length})`}
                </button>
                {showLog ? (
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-black/40 p-2 text-[11px] text-zinc-400">
                    {stderr.map((event) => event.text).join('\n')}
                  </pre>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <footer className="border-t border-white/10 px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={1}
            disabled={!ready || running || sending}
            placeholder={placeholder}
            aria-label="Message"
            className={cn(inputClass, 'resize-none leading-relaxed disabled:opacity-60')}
          />
          <div className="flex items-center gap-2">
            {showModelPicker && sessionId === null ? (
              <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model" className={selectClass}>
                {MODELS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs text-zinc-600">Enter sends, Shift+Enter for a new line</span>
            )}
            <span className="flex-1" />
            {running ? (
              <Button size="sm" variant="danger" onClick={stop}>
                Stop
              </Button>
            ) : null}
            <Button size="sm" variant="primary" onClick={() => void send()} disabled={!ready || running || sending || !draft.trim()}>
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  )
}

/** One line of the feed. Memoised: a poll adds a row, it must not redraw the rest. */
const EventRow = memo(function EventRow({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-indigo-500/20 px-3 py-2 text-sm text-zinc-100">{event.text}</div>
        </div>
      )
    case 'text':
      return (
        <div className="max-w-none text-sm leading-relaxed text-zinc-200">
          <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
            {event.text ?? ''}
          </Markdown>
        </div>
      )
    case 'tool':
      return (
        <div className="truncate pl-1 text-xs text-zinc-500" title={event.detail ?? undefined}>
          {toolLabel(event.name ?? '', event.detail ?? '')}
        </div>
      )
    case 'start':
      return <div className="text-[11px] text-zinc-600">session started</div>
    case 'result':
      return (
        <div
          className={cn(
            'rounded-md px-3 py-1.5 text-xs',
            event.stopped ? 'bg-amber-500/10 text-amber-200' : event.success ? 'bg-emerald-500/10 text-emerald-200' : 'bg-red-500/10 text-red-200',
          )}
        >
          {resultText(event)}
        </div>
      )
    case 'needs_auth':
      return (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Claude Code is not signed in on the machine with the library. Run <code className="rounded bg-white/10 px-1">claude</code> in a
          terminal there, sign in with <code className="rounded bg-white/10 px-1">/login</code>, and send the message again.
          {event.text ? <div className="mt-1 text-amber-200/70">{event.text}</div> : null}
        </div>
      )
    case 'error':
      return <pre className="whitespace-pre-wrap rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">{event.text}</pre>
    default:
      return null
  }
})
