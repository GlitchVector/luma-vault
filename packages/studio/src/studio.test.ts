import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approve, parseProposals, pass, writeProposals } from './canon.ts'
import { assemble, render } from './context.ts'
import { applyPatch, describe as describePatch, lockPath, patchReplySchema } from './director.ts'
import { extractJson } from './model/model.ts'
import { configSchema, initStudio, modelConfigFor, openStudio, scaffoldCharacter, validId, type Studio } from './root.ts'
import { seedAri } from './seed-ari.ts'
import { nextId, panelSchema, readPanel, writeComic, writePanel, writeScene } from './spec.ts'
import { comicStatus, formatStatus } from './status.ts'

let root: string
let studio: Studio
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-'))
  initStudio(root)
  studio = openStudio(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the root', () => {
  it('lays out the folders once and never overwrites', () => {
    expect(existsSync(join(root, 'world', 'canon.md'))).toBe(true)
    writeFileSync(join(root, 'world', 'canon.md'), '# mine')
    expect(initStudio(root)).toEqual([])
    expect(readFileSync(join(root, 'world', 'canon.md'), 'utf8')).toBe('# mine')
  })

  it('seeds Ari with what is known and leaves the rest empty', () => {
    const made = seedAri(studio)
    expect(made).toContain(join('characters', 'ari', 'appearance.md'))
    expect(readFileSync(join(root, 'characters', 'ari', 'appearance.md'), 'utf8')).toContain('white-to-teal bob')
    expect(readFileSync(join(root, 'characters', 'ari', 'personality.md'), 'utf8')).toContain('Nothing established yet')
    expect(existsSync(join(root, 'characters', 'ari', 'outfits', 'default.yaml'))).toBe(true)
    expect(seedAri(studio)).toEqual([])
  })

  it('keeps ids to folder names', () => {
    expect(validId('ari')).toBe(true)
    expect(validId('comic_001')).toBe(true)
    expect(validId('../x')).toBe(false)
    expect(validId('Ari')).toBe(false)
  })
})

describe('proposals and canon', () => {
  it('writes proposals a person can tick, and only approve moves them into canon', () => {
    scaffoldCharacter(studio, 'ari', 'Ari')
    const path = writeProposals(studio, { character: 'ari' }, 'how she jokes', [
      { title: 'Deflects with deadpan', text: 'She answers a compliment with a flat statement of fact.\n\nIt lands as a joke only later.' },
      { title: 'Laughs at herself first', text: 'Before anyone can.' },
      { title: 'Never on purpose', text: 'Her jokes are accidents she then owns.' },
    ])
    const parsed = parseProposals(path)
    expect(parsed.ask).toBe('how she jokes')
    expect(parsed.proposals.map((p) => [p.n, p.title, p.state])).toEqual([
      [1, 'Deflects with deadpan', 'open'],
      [2, 'Laughs at herself first', 'open'],
      [3, 'Never on purpose', 'open'],
    ])
    expect(parsed.proposals[0]!.text).toBe('She answers a compliment with a flat statement of fact.\n\nIt lands as a joke only later.')

    // Canon untouched until approved.
    expect(readFileSync(join(root, 'characters', 'ari', 'humor.md'), 'utf8')).toContain('Nothing established yet')
    const result = approve(studio, { character: 'ari' }, 'latest', [1, 3], 'humor')
    const humor = readFileSync(result.file, 'utf8')
    expect(humor).not.toContain('Nothing established yet')
    expect(humor).toMatch(/## Approved \d{4}-\d{2}-\d{2} \(from .*how-she-jokes\.md\)/)
    expect(humor).toContain('**Deflects with deadpan.** She answers')
    expect(humor).toContain('**Never on purpose.**')
    expect(humor).not.toContain('Laughs at herself')

    // Approved twice is refused; passed is remembered.
    expect(() => approve(studio, { character: 'ari' }, 'latest', [1], 'humor')).toThrow(/already approved/)
    pass(studio, { character: 'ari' }, 'latest', [2])
    expect(parseProposals(path).proposals.map((p) => p.state)).toEqual(['approved', 'passed', 'approved'])
  })

  it('routes only explicit tasks to the explicit model, and only when one is set', () => {
    const grok = { backend: 'openai-compatible' as const, url: 'https://api.x.ai/v1', model: 'grok-4.7', api_key_env: 'XAI_API_KEY', temperature: 0.9 }
    const both = configSchema.parse({ model: { backend: 'claude-cli' }, explicit_model: grok })
    expect(modelConfigFor(both, false).backend).toBe('claude-cli')
    expect(modelConfigFor(both, true).model).toBe('grok-4.7')
    const one = configSchema.parse({ model: { backend: 'claude-cli' } })
    expect(modelConfigFor(one, true).backend).toBe('claude-cli')
  })

  it('refuses a canon file that is not one', () => {
    scaffoldCharacter(studio, 'ari', 'Ari')
    writeProposals(studio, { character: 'ari' }, 'x', [{ title: 't', text: 'b' }])
    expect(() => approve(studio, { character: 'ari' }, 'latest', [1], 'secrets')).toThrow(/not a character file/)
  })
})

function comicWithPanel(): void {
  seedAri(studio)
  scaffoldCharacter(studio, 'maya', 'Maya')
  writeComic(studio, { id: 'comic_001', title: 'Hotel', characters: ['ari', 'maya'], concept: 'approved', outline: 'draft' })
  writeScene(studio, 'comic_001', {
    id: 'scene_004',
    title: 'Teasing',
    purpose: 'Sexual tension and defensive humor.',
    characters: ['ari', 'maya'],
    location: 'hotel_room',
    start_state: { ari: { mood: 'irritated' }, maya: { mood: 'playful' } },
    beats: ['Maya notices Ari avoiding eye contact.', 'Maya teases her.'],
    end_state: { ari: { mood: 'embarrassed_but_amused' } },
    continuity_changes: [],
    status: 'production',
  })
  writePanel(
    studio,
    'comic_001',
    panelSchema.parse({
      id: 'panel_017',
      scene: 'scene_004',
      story_function: 'Ari hides that the comment landed.',
      camera: { framing: 'medium', angle: 'slight_low', focal_feel: '50mm' },
      environment: { location: 'hotel_room', lighting: 'warm_evening' },
      characters: {
        ari: { screen_position: 'left_foreground', pose: 'standing', gaze_target: 'maya', expression: 'annoyed_but_amused', outfit: 'hotel_outfit_01' },
        maya: { screen_position: 'right_background', pose: 'sitting_on_bed', gaze_target: 'viewer', expression: 'smug', outfit: 'hotel_outfit_02' },
      },
      locked: ['location', 'lighting', 'ari_outfit', 'maya_outfit'],
      status: 'PLANNED',
    }),
  )
}

describe('the director', () => {
  it('reads the plan short names as paths', () => {
    expect(lockPath('location', ['ari'])).toBe('environment.location')
    expect(lockPath('ari_outfit', ['ari', 'maya'])).toBe('characters.ari.outfit')
    expect(lockPath('maya', ['ari', 'maya'])).toBe('characters.maya')
    expect(lockPath('background', [])).toBe('environment')
    expect(lockPath('characters.ari.pose', ['ari'])).toBe('characters.ari.pose')
  })

  it('applies what the instruction asks, refuses locked paths, and records history', () => {
    comicWithPanel()
    const panel = readPanel(studio, 'comic_001', 'panel_017')
    const reply = patchReplySchema.parse({
      patch: {
        'characters.ari.screen_position': 'far_left_foreground',
        'camera.angle': 'low',
        'characters.maya.gaze_target': 'ari',
        'environment.lighting': 'cold_morning',
        'characters.ari.outfit': 'towel',
        status: 'APPROVED',
      },
      note: 'lighting is locked',
    })
    const applied = applyPatch(panel, reply, 'Ari farther left, camera down, Maya looks at Ari', new Date('2026-09-18T00:00:00Z'))
    expect(applied.changes.map((c) => c.path)).toEqual(['characters.ari.screen_position', 'camera.angle', 'characters.maya.gaze_target'])
    expect(applied.refused).toEqual([
      { path: 'environment.lighting', lock: 'environment.lighting' },
      { path: 'characters.ari.outfit', lock: 'characters.ari.outfit' },
      { path: 'status', lock: 'not a directable field' },
    ])
    expect(applied.panel.characters['maya']!.gaze_target).toBe('ari')
    expect(applied.panel.environment.lighting).toBe('warm_evening')
    expect(applied.panel.status).toBe('PLANNED')
    expect(applied.panel.history).toHaveLength(1)
    expect(applied.panel.history[0]).toMatchObject({
      at: '2026-09-18T00:00:00.000Z',
      instruction: 'Ari farther left, camera down, Maya looks at Ari',
      patch: { 'camera.angle': 'low' },
      refused: ['environment.lighting', 'characters.ari.outfit', 'status'],
    })
    // Locks are normalised to paths on the way out.
    expect(applied.locked).toEqual(['environment.location', 'environment.lighting', 'characters.ari.outfit', 'characters.maya.outfit'])
    const text = describePatch(applied)
    expect(text).toContain('- characters.ari.screen_position: "left_foreground"')
    expect(text).toContain('+ characters.ari.screen_position: "far_left_foreground"')
    expect(text).toContain('! environment.lighting refused — locked by environment.lighting')
    // The original is untouched.
    expect(panel.characters['maya']!.gaze_target).toBe('viewer')
  })

  it('locks, unlocks, adds a field, and removes one with null', () => {
    comicWithPanel()
    const panel = readPanel(studio, 'comic_001', 'panel_017')
    const first = applyPatch(panel, patchReplySchema.parse({ patch: {}, lock: ['background'] }), 'background is perfect, lock it')
    expect(first.locked).toContain('environment')
    const blocked = applyPatch(first.panel, patchReplySchema.parse({ patch: { 'environment.props': 'a lamp' } }), 'add a lamp')
    expect(blocked.refused[0]).toEqual({ path: 'environment.props', lock: 'environment' })
    const opened = applyPatch(
      first.panel,
      patchReplySchema.parse({ patch: { 'environment.props': 'a lamp', 'camera.focal_feel': null }, unlock: ['background'] }),
      'unlock the background, add a lamp, drop the focal note',
    )
    expect(opened.changes.map((c) => c.path)).toEqual(['environment.props', 'camera.focal_feel'])
    expect((opened.panel.environment as Record<string, unknown>)['props']).toBe('a lamp')
    expect(opened.panel.camera.focal_feel).toBeUndefined()
    expect(opened.locked).not.toContain('environment')
  })
})

describe('context and status', () => {
  it('assembles only what a task needs and skips stubs', () => {
    comicWithPanel()
    const direct = assemble(studio, { kind: 'direct', comic: 'comic_001', panel: 'panel_017' })
    const sources = direct.map((b) => b.source)
    expect(sources).toContain('characters/ari/appearance.md')
    expect(sources).toContain('characters/ari/outfits/default.yaml')
    expect(sources).toContain('comics/comic_001/scenes/scene_004.yaml')
    expect(sources).toContain('comics/comic_001/panels/panel_017.yaml')
    expect(sources.some((s) => s.includes('personality'))).toBe(false)
    expect(sources.some((s) => s.includes('maya/appearance'))).toBe(false) // a stub

    const story = assemble(studio, { kind: 'story.brainstorm', comic: 'comic_001' })
    expect(story.map((b) => b.source)).toContain('characters/ari/core.md')
    expect(story.some((b) => b.source.includes('appearance'))).toBe(false)
    expect(render(direct)).toContain('### comics/comic_001/panels/panel_017.yaml')
  })

  it('reports states, scenes and a panel directed three times without approval', () => {
    comicWithPanel()
    const panel = readPanel(studio, 'comic_001', 'panel_017')
    panel.status = 'REVIEW'
    panel.history = [1, 2, 3].map((n) => ({ at: 'x', instruction: `try ${n}`, patch: {}, refused: [] }))
    writePanel(studio, 'comic_001', panel)
    writePanel(studio, 'comic_001', panelSchema.parse({ id: 'panel_018', scene: 'scene_004', status: 'APPROVED' }))
    const status = comicStatus(studio, 'comic_001')
    expect(status.panels.REVIEW).toBe(1)
    expect(status.panels.APPROVED).toBe(1)
    expect(status.scenes[0]).toMatchObject({ id: 'scene_004', status: 'production', panels: 2 })
    expect(status.blockers[0]).toContain('panel_017 — 3 directions, still REVIEW')
    const text = formatStatus(status)
    expect(text).toContain('COMIC comic_001 — Hotel')
    expect(text).toContain('APPROVED: 1')
  })

  it('numbers the next scene and panel', () => {
    expect(nextId([], 'scene')).toBe('scene_001')
    expect(nextId(['panel_001', 'panel_017'], 'panel')).toBe('panel_018')
  })
})

describe('json from a chatty model', () => {
  it('finds the object in prose or a fence', () => {
    expect(extractJson('Sure!\n```json\n{"proposals":[{"title":"a","text":"b"}]}\n```')).toEqual({ proposals: [{ title: 'a', text: 'b' }] })
    expect(extractJson('{"patch":{"x":"{"}} trailing')).toEqual({ patch: { x: '{' } })
  })
})
