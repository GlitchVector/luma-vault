/**
 * The Comics panel's pure parts: the rules that decide what the person is
 * told, separated from the markup that tells them.
 */
import { describe, expect, it } from 'vitest'
import type { ComicSummary } from '@luma/core'
import { blankPanel, describeEvent, layoutLabel, parseScript, renumber, standing } from './ComicsPanel.tsx'

const summary = (patch: Partial<ComicSummary> = {}): ComicSummary => ({
  name: 'first-light',
  title: 'First Light',
  pages: 3,
  panels: 11,
  rendered: 11,
  assembled: 3,
  hasProse: true,
  hasScript: true,
  thumb: null,
  updatedAt: 0,
  ...patch,
})

describe('where a comic stands', () => {
  it('is a draft until there is a script, whatever else is in the folder', () => {
    expect(standing(summary({ hasScript: false })).label).toBe('Draft')
  })

  it('is complete only when every page has been assembled', () => {
    expect(standing(summary()).label).toBe('Completed')
    expect(standing(summary({ assembled: 2 })).label).toBe('In progress')
  })

  it('is never complete with no pages at all', () => {
    expect(standing(summary({ pages: 0, assembled: 0 })).label).toBe('In progress')
  })
})

describe('the layout picker', () => {
  it('reads a preset name as words, with its cell count', () => {
    expect(layoutLabel('grid-2x2', 4)).toBe('Grid 2x2 (4 panels)')
    expect(layoutLabel('splash', 1)).toBe('Splash (1 panel)')
  })
})

describe('a new panel', () => {
  it(`takes the editor's default anchor, so a page of them matches`, () => {
    expect(blankPanel(2, 3, 'top-right').reserve_space).toBe('top-right')
    expect(blankPanel(2, 3).reserve_space).toBe('none')
    expect(blankPanel(2, 3).id).toBe('p2-3')
  })
})

describe('renumbering', () => {
  it('follows position, so a removed panel closes the gap', () => {
    const pages = [{ layout: 'two-stack', panels: [blankPanel(1, 5), blankPanel(1, 9)] }]
    expect(renumber(pages).map((page) => page.panels.map((p) => p.id))).toEqual([['p1-1', 'p1-2']])
  })
})

describe('reading a script off the wire', () => {
  it('says nothing about nothing', () => {
    expect(parseScript(null)).toEqual({ script: null, error: null })
  })

  it('names the field that does not fit rather than throwing', () => {
    const { script, error } = parseScript({ title: 'x', characters: {}, pages: 'not an array' })
    expect(script).toBeNull()
    expect(error).toMatch(/pages/)
  })
})

describe('the one line about what the pipeline is doing', () => {
  it('reads a panel event with its progress and seed', () => {
    const said = describeEvent({
      seq: 1,
      event: 'panel',
      stage: null,
      id: 'p1-2',
      status: 'rendering',
      progress: 0.5,
      eta: 12,
      seed: 8812,
      attempt: null,
      page: null,
      path: null,
      kind: null,
      message: null,
      failures: null,
    })
    expect(said).toBe('p1-2: rendering 50% (12s left) · seed 8812')
  })
})
