import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comicScriptSchema } from '@luma/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { anchorFor, cameraWords, exportComic, layoutFor, seedFamilyFor } from './export.ts'
import { initStudio, openStudio, scaffoldCharacter, type Studio } from './root.ts'
import { seedAri } from './seed-ari.ts'
import { panelSchema, writeComic, writePanel, writeScene } from './spec.ts'

let root: string
let studio: Studio

function stagedPanel(id: string, scene: string, over: Record<string, unknown> = {}) {
  return panelSchema.parse({
    id,
    scene,
    story_function: 'She sees it.',
    camera: { framing: 'medium shot', angle: 'slight_low' },
    environment: { location: 'rooftop', lighting: 'warm_evening' },
    characters: {
      ari: { screen_position: 'left_foreground', pose: 'standing', expression: 'annoyed_but_amused', gaze_target: 'the drone', outfit: 'default' },
    },
    ...over,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-export-'))
  initStudio(root)
  studio = openStudio(root)
  seedAri(studio)
  writeComic(studio, { id: 'comic_001', title: 'First Light', characters: ['ari'], concept: 'approved', outline: 'approved' })
  writeScene(studio, 'comic_001', {
    id: 'scene_001',
    title: 'Roof',
    purpose: 'x',
    characters: ['ari'],
    location: 'rooftop',
    start_state: {},
    beats: [],
    end_state: {},
    continuity_changes: [],
    status: 'production',
  })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('exporting a studio comic for the renderer', () => {
  it('writes a script the comic package can parse, with the cast resolved from generation.yaml', () => {
    writePanel(studio, 'comic_001', stagedPanel('panel_001', 'scene_001'))
    writePanel(studio, 'comic_001', stagedPanel('panel_002', 'scene_001'))
    const out = join(root, 'render')
    const done = exportComic(studio, 'comic_001', out)

    expect(done).toMatchObject({ pages: 1, panels: 2, characters: ['ari'] })
    const script = comicScriptSchema.parse(JSON.parse(readFileSync(join(out, 'script.json'), 'utf8')))
    expect(script.title).toBe('First Light')
    expect(script.pages[0]!.layout).toBe('two-stack')

    // The LoRA, trigger and weight come from the studio, never from a panel.
    expect(script.characters['ari']).toMatchObject({
      lora: 'ari_adopt_v1:1.2',
      trigger: 'ari',
      subject: '1girl',
    })
    expect(script.characters['ari']!.look).toContain('white hair')
    expect(script.characters['ari']!.seed_family).toBe(seedFamilyFor('ari'))
  })

  it('turns staging into prompt words, and puts the outfit in the scene rather than her look', () => {
    writePanel(studio, 'comic_001', stagedPanel('panel_001', 'scene_001'))
    const out = join(root, 'render')
    exportComic(studio, 'comic_001', out)
    const script = comicScriptSchema.parse(JSON.parse(readFileSync(join(out, 'script.json'), 'utf8')))
    const panel = script.pages[0]!.panels[0]!

    expect(panel.camera).toBe('medium shot, from below')
    expect(panel.scene).toContain('warm evening')
    expect(panel.scene).toContain('standing')
    expect(panel.scene).toContain('annoyed but amused')
    expect(panel.scene).toContain('looking at the drone')
    // The outfit's words, because she changes clothes between scenes and
    // `look` is one string for the whole script.
    expect(panel.scene).toContain('aqua shirt')
    expect(script.characters['ari']!.look).not.toContain('aqua shirt')
    expect(panel.characters).toEqual(['ari'])
  })

  it('points a balloon at where the speaker was staged', () => {
    writePanel(
      studio,
      'comic_001',
      stagedPanel('panel_001', 'scene_001', {
        dialogue: { status: 'draft', lines: [{ speaker: 'ari', text: 'Who lost you?', bubble_type: 'speech' }] },
      }),
    )
    const out = join(root, 'render')
    exportComic(studio, 'comic_001', out)
    const script = comicScriptSchema.parse(JSON.parse(readFileSync(join(out, 'script.json'), 'utf8')))
    const panel = script.pages[0]!.panels[0]!

    // She is staged left, so the balloon is top-left and its tail points
    // back down at her instead of at the middle of the frame.
    expect(panel.dialogue[0]).toMatchObject({ speaker: 'ari', text: 'Who lost you?', anchor: 'top-left', kind: 'speech' })
    expect(panel.dialogue[0]!.tail_to).toEqual({ x: 26, y: 58 })
    expect(panel.reserve_space).toBe('top-left')
  })

  it('splits a long scene across pages and picks a layout that fits', () => {
    for (let i = 1; i <= 6; i++) writePanel(studio, 'comic_001', stagedPanel(`panel_00${i}`, 'scene_001'))
    const done = exportComic(studio, 'comic_001', join(root, 'render'), { perPage: 4 })
    expect(done).toMatchObject({ pages: 2, panels: 6 })
    const script = comicScriptSchema.parse(JSON.parse(readFileSync(join(root, 'render', 'script.json'), 'utf8')))
    expect(script.pages.map((p) => p.layout)).toEqual(['grid-2x2', 'two-stack'])
  })

  it('skips a panel nobody has staged, and says which and why', () => {
    writePanel(studio, 'comic_001', stagedPanel('panel_001', 'scene_001'))
    writePanel(studio, 'comic_001', panelSchema.parse({ id: 'panel_002', scene: 'scene_001' }))
    const done = exportComic(studio, 'comic_001', join(root, 'render'))
    expect(done.panels).toBe(1)
    expect(done.skipped).toEqual([{ id: 'panel_002', why: 'nothing staged yet (no characters, no location, no story function)' }])
  })

  it('refuses a character with no generation.yaml rather than guessing a LoRA', () => {
    scaffoldCharacter(studio, 'maya', 'Maya')
    writePanel(
      studio,
      'comic_001',
      stagedPanel('panel_001', 'scene_001', { characters: { maya: { screen_position: 'right_background', pose: 'sitting' } } }),
    )
    expect(() => exportComic(studio, 'comic_001', join(root, 'render'))).toThrow(/maya has no generation.yaml/)
  })

  it('names the checkpoint the character is rendered on', () => {
    writePanel(studio, 'comic_001', stagedPanel('panel_001', 'scene_001'))
    const out = join(root, 'render')
    exportComic(studio, 'comic_001', out)
    const config = JSON.parse(readFileSync(join(out, 'comic.config.json'), 'utf8'))
    expect(config.forge.checkpoint).toBe('delburry75')
    expect(config.characters.ari.trigger).toBe('ari')
  })

  it('has a layout for every page size it will group, and a stable seed per name', () => {
    for (const n of [1, 2, 3, 4, 5, 6]) expect(() => layoutFor(n)).not.toThrow()
    expect(() => layoutFor(7)).toThrow(/no layout for 7/)
    expect(seedFamilyFor('ari')).toBe(seedFamilyFor('ari'))
    expect(seedFamilyFor('ari')).not.toBe(seedFamilyFor('maya'))
  })

  it("translates the director's camera prose into tags the checkpoint knows", () => {
    // Real strings the panel planner wrote for comic_001.
    expect(cameraWords('wide, full figure small against the building face', 'low, looking up the ladder run')).toBe('wide shot, full body, from below')
    expect(cameraWords('medium-wide, gravel field and vent housings filling the right of frame', 'near eye level, just at the parapet line')).toBe('medium shot')
    expect(cameraWords('close-up on the drone in the gap', 'high, looking down into the vent gap')).toBe('close-up, from above')
    expect(cameraWords('medium close-up over her shoulder, drone held in both hands', 'eye level with her hands')).toBe('upper body, from behind, over the shoulder')
  })

  it('never passes prose through as a prompt, and never renders without a camera', () => {
    // Prose the sampler would ignore contributes nothing; a panel with
    // nothing recognisable still gets a usable default rather than a
    // sentence.
    expect(cameraWords('gravel field and vent housings filling the frame', undefined)).toBe('medium shot')
    expect(cameraWords(undefined, undefined)).toBe('medium shot')
    expect(cameraWords('a lingering, contemplative framing', 'from the far side of the roof')).toBe('medium shot')
  })

  it('reads "medium close-up" as upper body, not as medium', () => {
    expect(cameraWords('medium close-up', undefined)).toBe('upper body')
    expect(cameraWords('medium shot', undefined)).toBe('medium shot')
    expect(cameraWords('extreme close-up', undefined)).toBe('close-up, face focus')
  })

  it('alternates balloon corners so two lines do not stack', () => {
    expect(anchorFor('left_foreground', 0).anchor).toBe('top-left')
    expect(anchorFor('left_foreground', 1).anchor).toBe('bottom-left')
    expect(anchorFor('right_background', 0)).toMatchObject({ anchor: 'top-right', tail: { x: 74, y: 45 } })
    expect(anchorFor(undefined, 0).anchor).toBe('top')
  })
})
