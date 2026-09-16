/**
 * A page as HTML. The stylesheet is the design; this file only says what is
 * on the page and where, in the vocabulary `theme.css` and `balloons.js`
 * understand: a grid, panels with spans, balloons with an anchor and a tail
 * target, sound effects with an anchor and a tilt.
 *
 * Every path is a URL under `http://comic.local/`, which the assembler serves
 * from disk through Playwright's request routing — no file:// origin rules,
 * no server to start.
 */

import { resolveGrid, resolveSpans } from '../layouts.ts'
import type { Anchor, Config, Dialogue, Page, Point } from '../schema.ts'

export const ORIGIN = 'http://comic.local'

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** Where a balloon's tail points when the script does not say: toward the
 *  middle of the picture from wherever the balloon sits, which is where a
 *  single framed figure is. */
export function defaultTailTarget(anchor: Anchor): Point {
  switch (anchor) {
    case 'top-left':
    case 'left':
      return { x: 52, y: 48 }
    case 'top-right':
    case 'right':
      return { x: 48, y: 48 }
    case 'top':
      return { x: 50, y: 45 }
    case 'bottom-left':
    case 'bottom-right':
    case 'bottom':
      return { x: 50, y: 55 }
    case 'center':
      return { x: 50, y: 70 }
  }
}

function balloonHtml(line: Dialogue): string {
  const tail = line.tail_to ?? defaultTailTarget(line.anchor)
  const tailAttr = line.kind === 'caption' ? '' : ` data-tail="${tail.x},${tail.y}"`
  return `<div class="balloon ${line.kind}" data-anchor="${line.anchor}"${tailAttr} data-speaker="${escape(line.speaker)}"><span class="text">${escape(line.text)}</span></div>`
}

export function pageHtml(page: Page, pageNumber: number, title: string, config: Pick<Config, 'page'>): string {
  const grid = resolveGrid(page)
  const spans = resolveSpans(page)
  const panels = page.panels
    .map((panel, index) => {
      const span = spans[index]!
      const clip = panel.clip ? `clip-path:${panel.clip};` : ''
      const balloons = panel.dialogue.map(balloonHtml).join('\n')
      const sfx = panel.sfx
        .map((s) => `<div class="sfx" data-anchor="${s.anchor}" style="--rotate:${s.rotate}deg">${escape(s.text)}</div>`)
        .join('\n')
      return `<figure class="panel" data-id="${panel.id}" style="grid-column:${span.col};grid-row:${span.row};${clip}">
  <img src="${ORIGIN}/panels/${panel.id}.png" alt="">
${balloons}
${sfx}
</figure>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(title)} — page ${pageNumber}</title>
<link rel="stylesheet" href="${ORIGIN}/assets/theme.css">
<style>:root { --page-w: ${config.page.width}px; --page-h: ${config.page.height}px; }</style>
</head>
<body>
<div class="page" data-page="${pageNumber}">
  <div class="grid" style="grid-template-columns:${grid.columns};grid-template-rows:${grid.rows}">
${panels}
  </div>
  <div class="folio">${pageNumber}</div>
</div>
<script src="${ORIGIN}/assets/balloons.js"></script>
</body>
</html>
`
}

/** The whole book as one printable document: each page PNG at print size. */
export function bookHtml(pageFiles: string[], title: string, config: Pick<Config, 'page'>): string {
  const widthIn = 6.625
  const heightIn = (widthIn * config.page.height) / config.page.width
  const pages = pageFiles.map((file) => `<img class="sheet" src="${ORIGIN}/out/${file}" alt="">`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<style>
@page { size: ${widthIn}in ${heightIn.toFixed(4)}in; margin: 0; }
html, body { margin: 0; padding: 0; }
.sheet { display: block; width: ${widthIn}in; height: ${heightIn.toFixed(4)}in; page-break-after: always; break-after: page; }
</style>
</head>
<body>
${pages}
</body>
</html>
`
}
