/**
 * The second pass: that a panel is asked for at the size its cell will show
 * it at, rather than enlarged afterwards.
 *
 * Planning is tested rather than rendering, because the only way to render a
 * hires panel is to allocate one — a few megapixels per panel, per case —
 * and the decision is where the behaviour lives.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cellPixels } from '../layouts.ts'
import { openProject } from '../project.ts'
import { drawPlaceholder } from '../render/mock.ts'
import type { Script } from '../schema.ts'
import { planPanel } from './panels.ts'

const script: Script = {
  title: 'Test',
  characters: {
    ari: { lora: 'ari_adopt_v1:1.2', trigger: 'ari', look: 'white hair', head: '', body: '', subject: '1girl', seed_family: 8812, minor: false },
  },
  locations: {},
  pages: [
    {
      layout: 'hero-top',
      panels: ['p1-1', 'p1-2', 'p1-3'].map((id) => ({
        id,
        camera: 'cowboy shot',
        scene: 'rooftop',
        pose: [],
        characters: ['ari'],
        reserve_space: 'none' as const,
        dialogue: [],
        sfx: [],
      })),
    },
  ],
}

let dir: string
const prepared = { checkpoint: 'delburry75.safetensors [abc]' }

function project(overrides: Record<string, unknown>) {
  writeFileSync(join(dir, 'comic.config.json'), JSON.stringify({ renderer: 'mock', plates: { backend: 'none' }, ...overrides }))
  return openProject(dir)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comic-hires-'))
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the hires target', () => {
  it('is the panel cell in device pixels, so the page stretches nothing', () => {
    const open = project({ page: { scale: 2 } })
    // The half-width cell: 926x1426, so twice it is under the ceiling and
    // the target is exactly what the page will display.
    const plan = planPanel(open, script, prepared, { pageIndex: 0, panelIndex: 1 })
    const cell = cellPixels(script.pages[0]!, 1, open.config)
    expect(plan.request.hires).toBeDefined()
    expect(plan.request.hires!.width).toBeCloseTo(cell.width * 2, -1)
    expect(plan.request.hires!.height).toBeCloseTo(cell.height * 2, -1)
    // The first pass still composes where the checkpoint is comfortable.
    expect(plan.request.width * plan.request.height).toBeLessThan(1.4e6)
  })

  it('runs at scale 1 as well, where the browser used to do the stretching', () => {
    const open = project({ page: { scale: 1 } })
    // The full-width hero cell is 1880 across and composes at 1160: a 62%
    // stretch that nothing was correcting, because the assembler only
    // enlarged panels when the page scale was above 1.
    const plan = planPanel(open, script, prepared, { pageIndex: 0, panelIndex: 0 })
    const cell = cellPixels(script.pages[0]!, 0, open.config)
    expect(plan.request.hires!.width).toBeCloseTo(cell.width, -1)
    expect(plan.request.hires!.width).toBeGreaterThan(plan.request.width)
  })

  it('leaves a half-width cell at scale 1 alone, at 14% under the bar', () => {
    const open = project({ page: { scale: 1 } })
    expect(planPanel(open, script, prepared, { pageIndex: 0, panelIndex: 1 }).request.hires).toBeUndefined()
  })

  it('gives up size rather than shape on a cell too big for the ceiling', () => {
    const open = project({ page: { scale: 2 } })
    const plan = planPanel(open, script, prepared, { pageIndex: 0, panelIndex: 0 })
    const cell = cellPixels(script.pages[0]!, 0, open.config)
    const hires = plan.request.hires!
    // 1880x1426 doubled is 10.7 MP, past the 6 MP ceiling, so the panel
    // comes out short of its cell and the assembler's upscaler covers the
    // rest — the fallback, not the plan.
    expect(hires.width * hires.height).toBeLessThan(6.1e6)
    expect(hires.width / hires.height).toBeCloseTo(cell.width / cell.height, 2)
  })

  it('is part of the hash, so another page scale is another picture', () => {
    const one = planPanel(project({ page: { scale: 1 } }), script, prepared, { pageIndex: 0, panelIndex: 0 })
    const two = planPanel(project({ page: { scale: 2 } }), script, prepared, { pageIndex: 0, panelIndex: 0 })
    expect(one.request.seed).toBe(two.request.seed)
    expect(one.hash).not.toBe(two.hash)
  })

  it('is left out when it would barely change the size', () => {
    // A cell only a few percent wider than the composed panel is not worth a
    // second pass; the browser's downsample is sharp.
    const open = project({ page: { scale: 1 }, forge: { hires: { min_factor: 4 } } })
    expect(planPanel(open, script, prepared, { pageIndex: 0, panelIndex: 0 }).request.hires).toBeUndefined()
  })

  it('is left out when it is switched off, and the rest of the forge section survives', () => {
    const open = project({ page: { scale: 2 }, forge: { hires: { enabled: false } } })
    expect(planPanel(open, script, prepared, { pageIndex: 0, panelIndex: 0 }).request.hires).toBeUndefined()
    // The nested override must not have taken the checkpoint with it.
    expect(open.config.forge.checkpoint).toBeTruthy()
    expect(open.config.forge.steps).toBeGreaterThan(0)
  })
})

describe('the mock renderer', () => {
  it('comes out at the hires size, so the assembler can be tested without a GPU', () => {
    const png = PNG.sync.read(
      drawPlaceholder({
        width: 128,
        height: 192,
        seed: 1,
        prompt: 'x',
        hires: { width: 256, height: 384, upscaler: 'none', denoise: 0.45, steps: 14 },
      }),
    )
    expect([png.width, png.height]).toEqual([256, 384])
  })
})

describe('a comic overriding one field of a character', () => {
  it("keeps the rest of her from the book's config", () => {
    const config = project({ characters: { ari: { body: '(huge breasts:1.3)' } } }).config
    expect(config.characters['ari']!.body).toBe('(huge breasts:1.3)')
    expect(config.characters['ari']!.lora).toMatch(/^ari_/)
    expect(config.characters['ari']!.trigger).toBe('ari')
  })
})

describe('a script written before the config changed', () => {
  it("draws her with the config's body, not the script's copy", async () => {
    const { loadScript } = await import('../project.ts')
    const changed = project({ characters: { ari: { body: '(huge breasts:1.3)' } } })
    expect(loadScript(changed).characters['ari']!.body).toBe('(huge breasts:1.3)')
  })
})
