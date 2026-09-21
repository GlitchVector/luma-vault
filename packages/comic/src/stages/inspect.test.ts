/**
 * `comic inspect`: the answer the app shows as a "changed" badge.
 *
 * Every case here is one the app got wrong before it existed — a folder of
 * mock placeholders shown as finished work, and panels that no longer matched
 * the script sitting under a green tick.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openProject } from '../project.ts'
import { Reporter } from '../report.ts'
import type { Script } from '../schema.ts'
import { inspect } from './inspect.ts'
import { runPanels } from './panels.ts'

const panel = (id: string, scene: string) => ({
  id,
  camera: 'cowboy shot',
  scene,
  pose: [],
  characters: ['ari'],
  reserve_space: 'none' as const,
  dialogue: [],
  sfx: [],
})

const script: Script = {
  title: 'Test',
  characters: {
    ari: { lora: 'ari_adopt_v1:1.2', trigger: 'ari', look: 'white hair', head: '', body: '', subject: '1girl', seed_family: 8812 },
  },
  locations: {},
  pages: [{ layout: 'two-stack', panels: [panel('p1-1', 'rooftop'), panel('p1-2', 'stairwell')] }],
}

let dir: string
const report = new Reporter(true)

function config(overrides: Record<string, unknown> = {}) {
  writeFileSync(
    join(dir, 'comic.config.json'),
    JSON.stringify({
      renderer: 'mock',
      plates: { backend: 'none' },
      page: { scale: 1 },
      forge: { hires: { enabled: false } },
      ...overrides,
    }),
  )
}

function writeScript(value: Script) {
  writeFileSync(join(dir, 'script.json'), JSON.stringify(value))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'comic-inspect-'))
  config()
  writeScript(script)
  await runPanels(openProject(dir), report)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('inspect', () => {
  it('calls a freshly rendered panel current', () => {
    const result = inspect(openProject(dir))
    expect(result.panels.map((p) => p.status)).toEqual(['current', 'current'])
    expect(result.panels.every((p) => p.reason === undefined)).toBe(true)
  })

  it('names the scene edit that left a panel behind, and leaves its neighbour alone', () => {
    writeScript({
      ...script,
      pages: [{ layout: 'two-stack', panels: [panel('p1-1', 'rooftop at dawn'), panel('p1-2', 'stairwell')] }],
    })
    const result = inspect(openProject(dir))
    expect(result.panels[0]).toEqual({ id: 'p1-1', status: 'stale', reason: 'the prompt changed' })
    expect(result.panels[1]!.status).toBe('current')
  })

  it('does not mind a dialogue edit, which never reaches the picture', () => {
    const pages = structuredClone(script.pages)
    pages[0]!.panels[0]!.dialogue = [{ speaker: 'ari', text: 'Look at that', anchor: 'top', kind: 'speech' }]
    writeScript({ ...script, pages })
    expect(inspect(openProject(dir)).panels.every((p) => p.status === 'current')).toBe(true)
  })

  it('catches a settings change, and says which one', () => {
    config({ forge: { hires: { enabled: true } } })
    const result = inspect(openProject(dir))
    expect(result.panels[0]).toEqual({ id: 'p1-1', status: 'stale', reason: 'a second pass was added' })
  })

  it('catches placeholders left by the mock when the project renders on Forge', () => {
    config({ renderer: 'forge' })
    const result = inspect(openProject(dir))
    expect(result.panels[0]!.reason).toBe('drawn by the mock renderer, not forge')
    expect(result.panels.every((p) => p.status === 'stale')).toBe(true)
  })

  it('calls a panel with no PNG missing rather than stale', () => {
    unlinkSync(join(dir, 'panels', 'p1-1.png'))
    expect(existsSync(join(dir, 'panels', 'p1-1.json'))).toBe(true)
    expect(inspect(openProject(dir)).panels[0]).toEqual({ id: 'p1-1', status: 'missing' })
  })

  it('reports the settings in force, for the app to show before a render', () => {
    config({
      page: { scale: 2 },
      forge: { checkpoint: 'delnoob', hires: { enabled: true, denoise: 0.5 } },
      prompt: { style: 'watercolour', quality: 'masterpiece', lighting: 'candlelight' },
    })
    const { settings } = inspect(openProject(dir))
    expect(settings).toEqual({
      renderer: 'mock',
      checkpoint: 'delnoob',
      style: 'watercolour',
      globalTags: 'masterpiece',
      lighting: 'candlelight',
      pageWidth: 2000,
      pageHeight: 3000,
      pageScale: 2,
      hiresEnabled: true,
      hiresDenoise: 0.5,
      plates: false,
    })
  })
})
