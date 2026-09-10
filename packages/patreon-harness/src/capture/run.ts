/**
 * Running one capture, with a human in the driving seat.
 *
 * The harness opens a browser, shows the checklist, records, and waits. It does
 * not click, type, log in, or navigate anywhere except the editor's front door.
 * The operator does the post; the machine does the recording and — the part
 * that actually matters — the scrubbing afterwards.
 *
 * A HAR of a logged-in session *is* the session. So the raw file is written to
 * a gitignored directory, scrubbed the moment the browser closes, and deleted
 * unless it was explicitly asked for.
 */

import { createInterface } from 'node:readline/promises'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { BrowserContext } from 'playwright-core'
import { openOperatorBrowser } from '../browser.ts'
import { findSecrets, scrubHar } from '../scrub.ts'
import type { Fixture } from './fixtures.ts'
import { BODY_ID, COUNT_ID, installOverlay, PANEL_ID } from './overlay.ts'

/**
 * Where a capture starts. The only two URLs this project navigates to on its
 * own, and both are front doors — anything deeper would be a guess, and the
 * operator is the one who knows where they are going.
 */
const EDITOR_URL = 'https://www.patreon.com/posts/new'

export interface CaptureOptions {
  readonly fixture: Fixture
  /** Root for `raw/`, `profile/` and the scrubbed output. */
  readonly captureDir: string
  /** Keep the unscrubbed HAR. Off by default, and it stays out of git either way. */
  readonly keepRaw?: boolean
  readonly log?: (line: string) => void
}

export interface CaptureOutcome {
  readonly harPath: string
  readonly apiCalls: number
  readonly redactions: number
  readonly leftovers: readonly string[]
}

export async function runCapture(options: CaptureOptions): Promise<CaptureOutcome> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rawDir = resolve(options.captureDir, 'raw')
  const profileDir = resolve(options.captureDir, 'profile')
  await mkdir(rawDir, { recursive: true })
  await mkdir(options.captureDir, { recursive: true })

  const rawPath = join(rawDir, `${options.fixture.name}-${stamp}.har`)
  const harPath = join(options.captureDir, `${options.fixture.name}-${stamp}.scrubbed.har`)

  log(banner(options.fixture))

  const context = await openOperatorBrowser({ userDataDir: profileDir, harPath: rawPath })
  await context.addInitScript(installOverlay, {
    title: options.fixture.name,
    varies: options.fixture.varies,
    steps: options.fixture.steps,
    panelId: PANEL_ID,
    bodyId: BODY_ID,
    countId: COUNT_ID,
  })

  const counted = countApiCalls(context)
  const page = context.pages()[0] ?? (await context.newPage())
  await page.goto(options.fixture.startUrl ?? EDITOR_URL).catch(() => {
    // A redirect to the login wall is a perfectly normal first run: the
    // operator signs in in this window and the profile remembers it next time.
  })

  const ticker = setInterval(() => {
    void showCount(context, counted.total())
  }, 1000)

  const input = createInterface({ input: process.stdin, output: process.stdout })
  await input.question('\nRecording. Work through the checklist in the browser, then press Enter here… ')
  input.close()
  clearInterval(ticker)

  // The HAR is only written on close, so this is not optional bookkeeping.
  await context.close()

  const raw = await readFile(rawPath, 'utf8')
  const { har, redactions } = scrubHar(raw)
  await writeFile(harPath, JSON.stringify(har), 'utf8')
  const leftovers = findSecrets(har)
  if (options.keepRaw !== true) await rm(rawPath, { force: true })

  return { harPath, apiCalls: counted.total(), redactions, leftovers }
}

/**
 * Counted from Node, off Playwright's own event, rather than by patching
 * `fetch` in the page. See `overlay.ts` for why that distinction is not
 * fussiness.
 */
function countApiCalls(context: BrowserContext): { total: () => number } {
  let total = 0
  context.on('request', (request) => {
    const url = request.url()
    if (/patreon\.com\/api\//.test(url) || request.method() !== 'GET') total++
  })
  return { total: () => total }
}

async function showCount(context: BrowserContext, total: number): Promise<void> {
  const page = context.pages().at(-1)
  if (page === undefined) return
  await page
    .evaluate(
      (payload: { id: string; total: number }) => {
        const element = (globalThis as unknown as { document: { getElementById(id: string): { textContent: string } | null } }).document.getElementById(
          payload.id,
        )
        if (element !== null) element.textContent = String(payload.total)
      },
      { id: COUNT_ID, total },
    )
    // Navigating away mid-evaluate is normal and means nothing.
    .catch(() => undefined)
}

function banner(fixture: Fixture): string {
  return [
    '',
    `  capture: ${fixture.name}`,
    `  ${fixture.varies}`,
    '',
    '  A Chrome window is opening. You drive it — this tool only records.',
    '  If it asks you to sign in, sign in by hand; the profile remembers it.',
    '  The checklist sits bottom-left; click its header to collapse it.',
    '',
    ...fixture.steps.map((step, at) => `   ${at + 1}. ${step}`),
    '',
    '  Nothing here publishes. Everything stays a draft.',
  ].join('\n')
}
