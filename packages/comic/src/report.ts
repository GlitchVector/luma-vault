/**
 * One channel for what a stage says while it runs.
 *
 * Human lines go to stderr so stdout stays clean; with `--json` every event
 * is one JSON line on stdout instead, which is what the desktop app reads to
 * draw progress. The two never mix, so a caller parsing stdout never meets a
 * sentence.
 */

export type Event =
  | { event: 'stage'; stage: string; status: 'start' | 'done' | 'failed'; message?: string }
  | { event: 'panel'; id: string; status: 'planned' | 'cached' | 'rendering' | 'rendered' | 'failed'; progress?: number; eta?: number; attempt?: number; seed?: number; message?: string }
  | { event: 'qa'; id: string; status: 'ok' | 'failed' | 'retry'; failures?: string[]; attempt?: number; message?: string }
  | { event: 'page'; page: number; status: 'assembled'; path: string }
  | { event: 'output'; kind: 'pdf' | 'cbz' | 'script'; path: string }
  | { event: 'note'; message: string }

export class Reporter {
  private readonly json: boolean

  constructor(json: boolean) {
    this.json = json
  }

  emit(event: Event): void {
    if (this.json) {
      process.stdout.write(JSON.stringify(event) + '\n')
      return
    }
    process.stderr.write(describe(event) + '\n')
  }

  /** A transient line (progress) that the next line overwrites. */
  tick(event: Extract<Event, { event: 'panel' }>): void {
    if (this.json) {
      process.stdout.write(JSON.stringify(event) + '\n')
      return
    }
    if (process.stderr.isTTY) process.stderr.write(`\r${describe(event)}   `)
  }
}

function describe(event: Event): string {
  switch (event.event) {
    case 'stage':
      return `[${event.stage}] ${event.status}${event.message ? `: ${event.message}` : ''}`
    case 'panel': {
      const progress = event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : ''
      const eta = event.eta !== undefined && event.eta > 0 ? ` (${Math.round(event.eta)}s left)` : ''
      const seed = event.seed !== undefined ? ` seed ${event.seed}` : ''
      const attempt = event.attempt ? ` attempt ${event.attempt + 1}` : ''
      return `  ${event.id}: ${event.status}${seed}${attempt}${progress}${eta}${event.message ? ` — ${event.message}` : ''}`
    }
    case 'qa':
      return `  ${event.id}: ${event.status}${event.failures?.length ? ` (${event.failures.join(', ')})` : ''}${event.message ? ` — ${event.message}` : ''}`
    case 'page':
      return `  page ${event.page}: ${event.path}`
    case 'output':
      return `  ${event.kind}: ${event.path}`
    case 'note':
      return `note: ${event.message}`
  }
}
