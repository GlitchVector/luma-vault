/**
 * Stages 2 and 4 end to end on the mock renderer, in a temp project. Stage 3
 * needs Chrome and is exercised by the worked example, not here.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cellPixels, pageHtml } from '../assemble/page.ts'
import { openProject } from '../project.ts'
import { Reporter } from '../report.ts'
import type { Script } from '../schema.ts'
import { runPanels } from './panels.ts'
import { runQa } from './qa.ts'

let dir: string
const script: Script = {
  title: 'Test',
  characters: {
    ari: { lora: 'ari_adopt_v1:1.2', trigger: 'ari', look: 'white hair', head: '', body: '', subject: '1girl', seed_family: 8812, minor: false },
  },
  locations: {},
  pages: [
    {
      layout: 'hero-top',
      panels: [
        { id: 'p1-1', camera: 'wide shot', scene: 'rooftop', pose: [], characters: [], reserve_space: 'top', dialogue: [], sfx: [] },
        {
          id: 'p1-2',
          camera: 'close-up',
          scene: 'drone',
          pose: [],
          characters: ['ari'],
          reserve_space: 'top-right',
          dialogue: [{ speaker: 'ari', text: 'Hi', anchor: 'top-right', kind: 'speech' }],
          sfx: [],
        },
        // A prompt the mock cannot honour: it hatches the whole frame, so
        // the reserved corner is never usable and QA must retry and give up.
        { id: 'p1-3', camera: 'close-up', scene: 'MOCK_BUSY', pose: [], characters: ['ari'], reserve_space: 'top-left', dialogue: [], sfx: [] },
      ],
    },
  ],
}

const events: string[] = []
const report = new Proxy(new Reporter(true), {
  get(target, key) {
    if (key === 'emit' || key === 'tick') {
      return (event: { event: string; id?: string; status?: string }) => {
        events.push(`${event.event}:${event.id ?? ''}:${event.status ?? ''}`)
        return undefined
      }
    }
    return Reflect.get(target, key)
  },
})

beforeEach(() => {
  events.length = 0
  dir = mkdtempSync(join(tmpdir(), 'comic-pipe-'))
  // `hires` off and `scale` pinned: this suite is about the stages, and a
  // second pass would have the mock allocating six-megapixel placeholders
  // for every panel of every case. `hires.test.ts` covers the pass itself.
  writeFileSync(
    join(dir, 'comic.config.json'),
    JSON.stringify({
      renderer: 'mock',
      plates: { backend: 'none' },
      qa: { max_attempts: 2 },
      page: { scale: 1 },
      forge: { hires: { enabled: false } },
    }),
  )
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('panels', () => {
  it('renders every panel with a sidecar, then serves the second run from the cache', async () => {
    const project = openProject(dir)
    const plans = await runPanels(project, report)
    expect(plans.map((p) => p.seed)).toEqual([8812, 8822, 8832])
    // Each panel is rendered at its CELL's real aspect — the page minus its
    // margins, minus the gutters between tracks — so `object-fit: cover` on
    // the page has nothing to crop away.
    expect(plans.map((p) => `${p.request.width}x${p.request.height}`)).toEqual(['1160x880', '816x1256', '816x1256'])
    const box = { width: 2000, height: 3000, margin: 60, gutter: 28 }
    const hero = cellPixels(script.pages[0]!, 0, { page: box })
    const under = cellPixels(script.pages[0]!, 1, { page: box })
    expect(1160 / 880).toBeCloseTo(hero.width / hero.height, 2)
    expect(816 / 1256).toBeCloseTo(under.width / under.height, 2)
    for (const plan of plans) {
      expect(existsSync(plan.pngPath)).toBe(true)
      const sidecar = JSON.parse(readFileSync(plan.sidecarPath, 'utf8'))
      expect(sidecar).toMatchObject({ version: 1, panel: plan.id, hash: plan.hash, seed: plan.seed, attempt: 0 })
      expect(sidecar.request.prompt).not.toContain('Hi')
    }
    expect(events.filter((e) => e.endsWith(':rendered'))).toHaveLength(3)

    events.length = 0
    await runPanels(project, report)
    expect(events.filter((e) => e.endsWith(':cached'))).toHaveLength(3)
    expect(events.filter((e) => e.endsWith(':rendered'))).toHaveLength(0)
  })

  it('re-renders when the config changes, and honours an explicit seed for one panel', async () => {
    const project = openProject(dir)
    const [first] = await runPanels(project, report, { page: 1, panel: '2' })
    const bytes = readFileSync(first!.pngPath)

    const [again] = await runPanels(project, report, { page: 1, panel: 'p1-2' }, { seed: 4242, force: true })
    expect(again!.seed).toBe(4242)
    expect(readFileSync(again!.pngPath).equals(bytes)).toBe(false)

    await expect(runPanels(project, report, {}, { seed: 1 })).rejects.toThrow(/exactly one panel/)
    await expect(runPanels(project, report, { panel: '2' })).rejects.toThrow(/needs --page/)
  })

  it('is byte-identical for the same request', async () => {
    const project = openProject(dir)
    const [plan] = await runPanels(project, report, { page: 1, panel: 'p1-1' })
    const first = readFileSync(plan!.pngPath)
    await runPanels(project, report, { page: 1, panel: 'p1-1' }, { force: true })
    expect(readFileSync(plan!.pngPath).equals(first)).toBe(true)
  })
})

describe('qa', () => {
  it('reports a crowded lettering corner as a note and never re-renders for it', async () => {
    const project = openProject(dir)
    const verdicts = await runQa(project, report, {}, { tagger: null })
    // p1-3 has no room where its balloon goes, and that is no longer a gate:
    // re-rolling never produced room (measured), and balloons read over art.
    expect(verdicts.map((v) => [v.panel, v.ok, v.attempt])).toEqual([
      ['p1-1', true, 0],
      ['p1-2', true, 0],
      ['p1-3', true, 0],
    ])
    expect(verdicts[2]!.failures).toEqual([])
    expect(verdicts[2]!.notes).toEqual(['space: little empty room at top-left'])
    expect(events).not.toContain('qa:p1-3:retry')
    expect(existsSync(join(dir, 'qa', 'p1-3.json'))).toBe(true)
    // The first render is kept: nothing was thrown away for a note.
    const sidecar = JSON.parse(readFileSync(join(dir, 'panels', 'p1-3.json'), 'utf8'))
    expect(sidecar).toMatchObject({ attempt: 0, seed: 8832 })
  })

  it('still retries a real failure, and gives up at max_attempts', async () => {
    const project = openProject(dir)
    const tagger = { tag: async (paths: string[]) => new Map(paths.map((p) => [p, { 'no humans': 0.9 }])) }
    const verdicts = await runQa(project, report, { page: 1, panel: 'p1-2' }, { tagger })
    expect(verdicts[0]!.ok).toBe(false)
    expect(verdicts[0]!.failures).toEqual(['figures: expected one, found nobody'])
    expect(events).toContain('qa:p1-2:retry')
    expect(verdicts[0]!.attempt).toBe(1)
  })

  it('uses the tagger when given one', async () => {
    const project = openProject(dir)
    const tagger = { tag: async (paths: string[]) => new Map(paths.map((p) => [p, { 'no humans': 0.9 }])) }
    const verdicts = await runQa(project, report, { page: 1, panel: 'p1-2' }, { tagger, retry: false })
    expect(verdicts[0]!.failures).toEqual(['figures: expected one, found nobody'])
  })
})

describe('page html', () => {
  it('places the grid, the panels and the balloons, with dialogue only in balloons', () => {
    const html = pageHtml(script.pages[0]!, 1, 'Test', { page: { width: 2000, height: 3000, scale: 1, margin: 60, gutter: 28 } })
    expect(html).toContain('grid-template-columns:repeat(2, 1fr)')
    expect(html).toContain('grid-column:1 / 3;grid-row:1')
    expect(html).toContain('src="http://comic.local/panels/p1-2.png"')
    expect(html).toContain('<div class="balloon speech" data-anchor="top-right" data-tail="48,48"')
    expect(html).toContain('<span class="text">Hi</span>')
  })
})
