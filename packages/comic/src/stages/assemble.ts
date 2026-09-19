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
import { ORIGIN, bookHtml, cellPixels, pageHtml, type PanelEnergy, type PanelSources } from '../assemble/page.ts'
import { energyMap } from '../assemble/energy.ts'
import { readSidecar, rendererFor } from './panels.ts'
import { ASSETS_DIR, loadScript, type Project } from '../project.ts'
import type { Reporter } from '../report.ts'
import type { Page as PageSpec } from '../schema.ts'
import { PNG } from 'pngjs'

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

/**
 * Panels enlarged for a retina page, cached by the hash of the request that
 * drew them, so re-assembling is free and a re-rendered panel is redone.
 *
 * ESRGAN rather than a second sampler pass: no prompt, no seed, and no
 * chance of inventing a second head, which is the risk of re-sampling a
 * panel at a size the checkpoint was not trained for.
 */
async function upscalePanels(project: Project, page: PageSpec, report: Reporter): Promise<PanelSources> {
  const sources: PanelSources = new Map()
  const scale = project.config.page.scale
  if (scale <= 1) return sources

  const renderer = rendererFor(project)
  if (!renderer.upscale) {
    report.emit({ event: 'note', message: `${renderer.name} cannot upscale, so the page will stretch the panels instead` })
    return sources
  }

  const dir = join(project.buildDir, 'retina')
  mkdirSync(dir, { recursive: true })
  for (const [index, panel] of page.panels.entries()) {
    const source = join(project.panelsDir, `${panel.id}.png`)
    const drawn = PNG.sync.read(readFileSync(source))
    const cell = cellPixels(page, index, project.config)
    // What the cell actually needs, not the device scale: a panel is drawn
    // at the sampler's comfortable size, which is smaller than its cell, so
    // doubling it would still leave the browser stretching it.
    // A whisker of headroom: Forge rounds the resize to whole pixels, and
    // landing four pixels short means the page stretches the panel after
    // all the trouble taken not to. Overshoot is free; the browser
    // downsamples, which is sharp.
    const needed = (cell.width * scale) / drawn.width
    const factor = Math.min(4, Math.max(1, needed * 1.01))
    const name = `${panel.id}-${readSidecar(join(project.panelsDir, `${panel.id}.json`))?.hash ?? 'nohash'}@${factor.toFixed(2)}x.png`
    const target = join(dir, name)
    if (!existsSync(target)) {
      report.emit({ event: 'panel', id: panel.id, status: 'rendering', message: `upscaling ${factor.toFixed(2)}x for the retina page` })
      // eslint-disable-next-line no-await-in-loop
      const big = await renderer.upscale(readFileSync(source), factor, project.config.forge.upscaler)
      writeFileSync(target, big)
    }
    sources.set(panel.id, `${ORIGIN}/build/retina/${name}`)
  }
  return sources
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
      // The layout stays in CSS pixels; only the device pixels double. That
      // is what makes the lettering redraw sharp instead of being enlarged.
      deviceScaleFactor: project.config.page.scale,
    })
    const tab = await context.newPage()
    await route(tab, project)

    for (const { page, number } of pages) {
      // Where the art is quiet, so a balloon can avoid the face it belongs to.
      const energy: PanelEnergy = new Map()
      for (const panel of page.panels) {
        energy.set(panel.id, energyMap(readFileSync(join(project.panelsDir, `${panel.id}.png`))))
      }
      // eslint-disable-next-line no-await-in-loop
      const sources = await upscalePanels(project, page, report)
      const html = pageHtml(page, number, script.title, project.config, energy, sources)
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
      // The PDF keeps its inch size whatever the pixel density: a retina page
      // prints at a higher DPI rather than on a bigger sheet.
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
