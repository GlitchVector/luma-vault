/**
 * Stage 3: panels and script in, page PNGs, a PDF and a CBZ out.
 *
 * The page is HTML laid out by Chrome and screenshotted through Playwright;
 * every file it references is served from disk by a request route on a
 * made-up origin, so there is no server to start and no file:// rule to
 * trip over. The PDF is the page PNGs placed at print size, one per sheet,
 * so what is in the PDF is exactly what is in the PNGs.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { zipSync } from 'fflate'
import { chromium, type Browser, type Page as BrowserPage } from 'playwright-core'
import { ORIGIN, bookHtml, pageHtml } from '../assemble/page.ts'
import { ASSETS_DIR, loadScript, type Project } from '../project.ts'
import type { Reporter } from '../report.ts'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
}

export interface AssembleOptions {
  page?: number
  formats?: Array<'png' | 'pdf' | 'cbz'>
}

export function pageFileName(pageNumber: number): string {
  return `page-${String(pageNumber).padStart(2, '0')}.png`
}

/** Serve `/assets`, `/panels`, `/build` and `/out` from their folders. */
async function route(page: BrowserPage, project: Project): Promise<void> {
  const roots: Record<string, string> = {
    assets: ASSETS_DIR,
    panels: project.panelsDir,
    build: project.buildDir,
    out: project.outDir,
  }
  await page.route(`${ORIGIN}/**`, async (handler) => {
    const url = new URL(handler.request().url())
    const [, root, ...rest] = url.pathname.split('/')
    const base = root ? roots[root] : undefined
    const file = base ? join(base, ...rest) : undefined
    if (!file || !existsSync(file)) {
      await handler.fulfill({ status: 404, body: `not found: ${url.pathname}` })
      return
    }
    await handler.fulfill({
      status: 200,
      contentType: TYPES[extname(file)] ?? 'application/octet-stream',
      body: readFileSync(file),
    })
  })
}

export async function runAssemble(project: Project, report: Reporter, options: AssembleOptions = {}): Promise<string[]> {
  const script = loadScript(project)
  const formats = options.formats ?? ['png', 'pdf', 'cbz']
  mkdirSync(project.buildDir, { recursive: true })
  mkdirSync(project.outDir, { recursive: true })
  report.emit({ event: 'stage', stage: 'assemble', status: 'start', message: formats.join(', ') })

  const pages = script.pages
    .map((page, index) => ({ page, number: index + 1 }))
    .filter(({ number }) => options.page === undefined || options.page === number)
  if (pages.length === 0) throw new Error(`no page ${options.page}`)

  for (const { page } of pages) {
    for (const panel of page.panels) {
      const png = join(project.panelsDir, `${panel.id}.png`)
      if (!existsSync(png)) throw new Error(`${panel.id} has not been rendered (${png}) — run \`comic panels\` first`)
    }
  }

  const browser = await launch(project.config.browser)
  const written: string[] = []
  try {
    const context = await browser.newContext({
      viewport: { width: project.config.page.width, height: project.config.page.height },
      deviceScaleFactor: 1,
    })
    const tab = await context.newPage()
    await route(tab, project)

    for (const { page, number } of pages) {
      const html = pageHtml(page, number, script.title, project.config)
      const htmlName = `page-${String(number).padStart(2, '0')}.html`
      writeFileSync(join(project.buildDir, htmlName), html)
      // One tab, one page at a time: the pages share the browser, not the work.
      // eslint-disable-next-line no-await-in-loop
      await tab.goto(`${ORIGIN}/build/${htmlName}`, { waitUntil: 'load' })
      // eslint-disable-next-line no-await-in-loop
      await tab.waitForSelector('body[data-ready="1"]', { timeout: 30_000 })
      const out = join(project.outDir, pageFileName(number))
      // eslint-disable-next-line no-await-in-loop
      await tab.locator('.page').screenshot({ path: out, type: 'png' })
      written.push(out)
      report.emit({ event: 'page', page: number, status: 'assembled', path: out })
    }

    // The book is every page PNG present, so assembling one page refreshes
    // the PDF and CBZ with the others as they were.
    const sheets = readdirSync(project.outDir)
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort()
    if (formats.includes('pdf')) {
      writeFileSync(join(project.buildDir, 'book.html'), bookHtml(sheets, script.title, project.config))
      await tab.goto(`${ORIGIN}/build/book.html`, { waitUntil: 'load' })
      const pdf = join(project.outDir, 'book.pdf')
      await tab.pdf({ path: pdf, printBackground: true, preferCSSPageSize: true })
      report.emit({ event: 'output', kind: 'pdf', path: pdf })
    }
    if (formats.includes('cbz')) {
      const entries: Record<string, Uint8Array> = {}
      for (const sheet of sheets) entries[sheet] = readFileSync(join(project.outDir, sheet))
      // Stored, not deflated (PNG is already compressed), and a fixed date, so
      // the archive's bytes depend on the pages alone.
      const cbz = join(project.outDir, 'book.cbz')
      writeFileSync(cbz, zipSync(entries, { level: 0, mtime: new Date(2000, 0, 1) }))
      report.emit({ event: 'output', kind: 'cbz', path: cbz })
    }
  } finally {
    await browser.close()
  }
  report.emit({ event: 'stage', stage: 'assemble', status: 'done' })
  return written
}

async function launch(channel: 'chrome' | 'msedge' | 'chromium'): Promise<Browser> {
  try {
    return await chromium.launch(channel === 'chromium' ? { headless: true } : { channel, headless: true })
  } catch (error) {
    throw new Error(
      `could not start ${channel} for the assembler: ${(error as Error).message}\n` +
        '  Install Google Chrome, or set "browser" in comic.config.json to "msedge".',
      { cause: error },
    )
  }
}
