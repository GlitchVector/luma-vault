/**
 * The face pass and the body ladder: the two things a person sets per panel.
 *
 * Both are about the same risk. A setting that applies everywhere is easy;
 * these have to apply at the right rung and nowhere else, because the pass
 * that fixes ten panels is the one that ruins the eleventh.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toPayload } from '../render/forge.ts'
import { bodyFor, lightingFor } from '../prompt.ts'
import { openProject } from '../project.ts'
import type { Character, Script } from '../schema.ts'
import { planPanel } from './panels.ts'

const ari: Character = {
  lora: 'ari_adopt_v1:1.2',
  trigger: 'ari',
  look: 'white hair, aqua shirt',
  head: 'white hair, blue eyes',
  body: 'large breasts, wide hips',
  subject: '1girl',
  seed_family: 8812, minor: false,
}

const panel = (id: string, characters: string[], extra: Record<string, unknown> = {}) => ({
  id,
  camera: 'cowboy shot',
  scene: 'rooftop',
  pose: [],
  characters,
  reserve_space: 'none' as const,
  dialogue: [],
  sfx: [],
  ...extra,
})

let dir: string
const prepared = { checkpoint: 'delburry75.safetensors [abc]' }

function project(script: Script, overrides: Record<string, unknown> = {}) {
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
  writeFileSync(
    join(dir, 'comic.config.json'),
    JSON.stringify({ renderer: 'mock', plates: { backend: 'none' }, page: { scale: 1 }, ...overrides }),
  )
  return openProject(dir)
}

const solo = (extra: Record<string, unknown> = {}, pageExtra: Record<string, unknown> = {}): Script => ({
  title: 'T',
  characters: { ari, kira: { ...ari, trigger: 'kvoss', seed_family: 1, minor: false } },
  locations: {},
  pages: [{ layout: 'splash', panels: [panel('p1-1', ['ari'], extra)], ...pageExtra }],
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comic-face-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the body ladder', () => {
  it("keeps her body always; page and panel only add to it", () => {
    expect(bodyFor(ari)).toBe('large breasts, wide hips')
    expect(bodyFor(ari, 'wet skin')).toBe('large breasts, wide hips, wet skin')
    expect(bodyFor(ari, 'wet skin', 'sweat')).toBe('large breasts, wide hips, wet skin, sweat')
    expect(bodyFor(ari, undefined, 'sweat')).toBe('large breasts, wide hips, sweat')
  })

  it('treats a blank rung as silence', () => {
    expect(bodyFor(ari, '')).toBe('large breasts, wide hips')
    expect(bodyFor(ari, '   ', '')).toBe('large breasts, wide hips')
  })

  it('uses the rear body for a back view', () => {
    const both = { ...ari, body_rear: 'large breasts, wide hips, (huge ass:1.6)' }
    expect(bodyFor(both, undefined, undefined, 'full body, from behind')).toBe('large breasts, wide hips, (huge ass:1.6)')
    expect(bodyFor(both, undefined, undefined, 'cowboy shot')).toBe('large breasts, wide hips')
    expect(bodyFor(ari, undefined, undefined, 'from behind')).toBe('large breasts, wide hips')
  })

  it('reaches the prompt, unweighted, straight after her look', () => {
    const script = solo()
    const plan = planPanel(project(script), script, prepared, { pageIndex: 0, panelIndex: 0 })
    expect(plan.request.prompt).toContain('white hair, aqua shirt, large breasts, wide hips')
    expect(plan.request.prompt).not.toContain('(large breasts')
  })

  it('lets a page and a panel add to her body, never replace it', () => {
    const byPage = solo({}, { body: 'wet skin' })
    expect(planPanel(project(byPage), byPage, prepared, { pageIndex: 0, panelIndex: 0 }).request.prompt).toContain('large breasts, wide hips, wet skin')

    const byPanel = solo({ body: 'sweat' }, { body: 'wet skin' })
    const prompt = planPanel(project(byPanel), byPanel, prepared, { pageIndex: 0, panelIndex: 0 }).request.prompt
    expect(prompt).toContain('large breasts, wide hips, wet skin, sweat')
  })
})

describe('the face pass', () => {
  it('is planned for a panel with one person in it', () => {
    const script = solo()
    const face = planPanel(project(script), script, prepared, { pageIndex: 0, panelIndex: 0 }).request.face
    expect(face).toBeDefined()
    // Her, and nothing about the scene: ADetailer paints what it is given
    // onto whatever it found.
    expect(face!.prompt).toContain('<lora:ari_adopt_v1:1.2>')
    expect(face!.prompt).toContain('ari')
    expect(face!.prompt).not.toContain('rooftop')
  })

  it('is left off a panel with nobody in it, where there is no face to fix', () => {
    const script = solo()
    script.pages[0]!.panels[0] = panel('p1-1', [])
    expect(planPanel(project(script), script, prepared, { pageIndex: 0, panelIndex: 0 }).request.face).toBeUndefined()
  })

  it('is left off a panel with two people, where one prompt would paint both', () => {
    const script = solo()
    script.pages[0]!.panels[0] = panel('p1-1', ['ari', 'kira'])
    expect(planPanel(project(script), script, prepared, { pageIndex: 0, panelIndex: 0 }).request.face).toBeUndefined()
  })

  it('obeys the panel over the config, in both directions', () => {
    const off = solo({ face: false })
    expect(planPanel(project(off), off, prepared, { pageIndex: 0, panelIndex: 0 }).request.face).toBeUndefined()

    const on = solo({ face: true })
    const open = project(on, { forge: { face: { enabled: false } } })
    expect(planPanel(open, on, prepared, { pageIndex: 0, panelIndex: 0 }).request.face).toBeDefined()
  })

  it('changes the hash, so switching it off re-renders that panel', () => {
    const withFace = solo()
    const without = solo({ face: false })
    const a = planPanel(project(withFace), withFace, prepared, { pageIndex: 0, panelIndex: 0 })
    const b = planPanel(project(without), without, prepared, { pageIndex: 0, panelIndex: 0 })
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('the ADetailer payload', () => {
  const base = {
    prompt: 'p',
    negative: 'n',
    seed: 1,
    width: 832,
    height: 1216,
    steps: 28,
    cfg: 5,
    sampler: 'Euler a',
    scheduler: 'Automatic',
    checkpoint: 'delburry75.safetensors [abc]',
    backend: 'forge',
  }
  const face = {
    prompt: 'ari',
    negative: 'bad',
    model: 'face_yolov8n.pt',
    confidence: 0.35,
    max_area: 0.1,
    denoise: 0.4,
    size: 1024,
    padding: 32,
    mask_blur: 0,
    steps: 30,
    cfg: 7,
    checkpoint: '',
  }

  it('rides in alwayson_scripts with the positional args Forge expects', () => {
    const payload = toPayload({ ...base, face }, { save_to_forge: true })
    const args = (payload['alwayson_scripts'] as { ADetailer: { args: unknown[] } }).ADetailer.args
    expect(args[0]).toBe(true)
    expect(args[1]).toBe(false)
    const unit = args[2] as Record<string, unknown>
    expect(unit['ad_model']).toBe('face_yolov8n.pt')
    // The gate that makes it a small-face pass.
    expect(unit['ad_mask_max_ratio']).toBe(0.1)
    expect(unit['ad_inpaint_width']).toBe(1024)
    expect(unit['ad_use_inpaint_width_height']).toBe(true)
    // The face gets its own steps and guidance, both above the panel's.
    expect(unit['ad_use_steps']).toBe(true)
    expect(unit['ad_steps']).toBe(30)
    expect(unit['ad_use_cfg_scale']).toBe(true)
    expect(unit['ad_cfg_scale']).toBe(7)
    expect(unit['ad_mask_blur']).toBe(0)
    expect(unit).not.toHaveProperty('ad_use_checkpoint')
  })

  it('names a checkpoint only when one was chosen', () => {
    const payload = toPayload({ ...base, face: { ...face, checkpoint: 'realismIllustrious' } }, { save_to_forge: true })
    const unit = (payload['alwayson_scripts'] as { ADetailer: { args: unknown[] } }).ADetailer.args[2] as Record<string, unknown>
    expect(unit['ad_use_checkpoint']).toBe(true)
    expect(unit['ad_checkpoint']).toBe('realismIllustrious')
  })

  it('says nothing at all when the panel has no face pass', () => {
    expect(toPayload(base, { save_to_forge: true })).not.toHaveProperty('alwayson_scripts')
  })
})

describe('the lighting ladder', () => {
  it('takes the most specific rung that is set', () => {
    expect(lightingFor('dawn')).toBe('dawn')
    expect(lightingFor('dawn', 'night')).toBe('night')
    expect(lightingFor('dawn', 'night', 'neon')).toBe('neon')
    expect(lightingFor('dawn', undefined, 'neon')).toBe('neon')
  })

  it('treats a blank rung as silence, so an empty page keeps the book lit', () => {
    expect(lightingFor('dawn', '')).toBe('dawn')
    expect(lightingFor('dawn', '  ', '')).toBe('dawn')
  })

  it('reaches the prompt after the scene, and a page can turn the lights off', () => {
    const lit = solo()
    const open = project(lit, { prompt: { lighting: 'sunrise, golden hour' } })
    const plan = planPanel(open, lit, prepared, { pageIndex: 0, panelIndex: 0 })
    expect(plan.request.prompt).toContain('rooftop, sunrise, golden hour')

    const night = solo({}, { lighting: 'night, neon' })
    const dark = planPanel(project(night, { prompt: { lighting: 'sunrise, golden hour' } }), night, prepared, { pageIndex: 0, panelIndex: 0 })
    expect(dark.request.prompt).toContain('night, neon')
    expect(dark.request.prompt).not.toContain('sunrise')
  })

  it('lets one panel break from its page', () => {
    const script = solo({ lighting: 'candlelight' }, { lighting: 'night, neon' })
    const plan = planPanel(project(script), script, prepared, { pageIndex: 0, panelIndex: 0 })
    expect(plan.request.prompt).toContain('candlelight')
    expect(plan.request.prompt).not.toContain('neon')
  })
})
