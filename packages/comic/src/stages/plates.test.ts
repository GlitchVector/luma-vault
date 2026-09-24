/**
 * The plate pass end to end on the mock backends: a master per location, a
 * plate per panel, the stand-in found and painted over, the cache keyed on
 * the plate, and a plate without a stand-in retried then failed.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openProject } from '../project.ts'
import { Reporter } from '../report.ts'
import type { Script } from '../schema.ts'
import { runPanels } from './panels.ts'
import { masterPaths, platePaths, readPlateSidecar, runPlates } from './plates.ts'

let dir: string
const script: Script = {
  title: 'Plates',
  characters: {
    ari: { lora: 'ari_adopt_v1:1.2', trigger: 'ari', look: 'white hair', head: '', body: '', subject: '1girl', seed_family: 8812, minor: false },
    kira: { lora: 'kvoss_v2:0.9', trigger: 'kvoss', look: 'pink hair', head: '', body: '', subject: '1girl', seed_family: 4400, minor: false },
  },
  locations: { rooftop: 'gravel rooftop of a brick radio building, grey dawn' },
  pages: [
    {
      layout: 'hero-top',
      panels: [
        { id: 'p1-1', camera: 'wide shot', scene: 'rooftop, dawn', location: 'rooftop', setting: 'the whole roof from above', pose: [], characters: [], reserve_space: 'top', dialogue: [], sfx: [] },
        {
          id: 'p1-2',
          camera: 'cowboy shot',
          scene: 'nude, explicit words only the local model sees',
          location: 'rooftop',
          setting: 'the parapet edge',
          pose: ['leaning on the rail', 'standing behind'],
          characters: ['ari', 'kira'],
          reserve_space: 'top-right',
          dialogue: [{ speaker: 'ari', text: 'Hi', anchor: 'top-right', kind: 'speech' }],
          sfx: [],
        },
        { id: 'p1-3', camera: 'close-up', scene: 'drone', setting: 'MOCK_NO_DUMMY vents', pose: [], characters: ['ari'], reserve_space: 'none', dialogue: [], sfx: [] },
      ],
    },
  ],
}

const events: Array<Record<string, unknown>> = []
const report = new Proxy(new Reporter(true), {
  get(target, key) {
    if (key === 'emit' || key === 'tick') return (event: Record<string, unknown>) => void events.push(event)
    return Reflect.get(target, key)
  },
})

beforeEach(() => {
  events.length = 0
  dir = mkdtempSync(join(tmpdir(), 'comic-plates-'))
  writeFileSync(join(dir, 'comic.config.json'), JSON.stringify({ renderer: 'mock', plates: { backend: 'mock' }, qa: { max_attempts: 2 } }))
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('plates', () => {
  it('draws one master per location and a plate per panel, and never sends the scene', async () => {
    const project = openProject(dir)
    await runPlates(project, report, { page: 1, panel: 'p1-2' })
    const master = readPlateSidecar(masterPaths(project, 'rooftop').sidecar)!
    expect(master.prompt).toContain('gravel rooftop')
    expect(master.prompt).toContain('no people')
    const plate = readPlateSidecar(platePaths(project, 'p1-2').sidecar)!
    expect(plate.master).toBe(master.hash)
    expect(plate.size).toBe('1024x1536')
    expect(plate.prompt).toContain('2 stand-in figures')
    expect(plate.prompt).toContain('leaning on the rail')
    expect(plate.prompt).not.toMatch(/nude|explicit/)

    events.length = 0
    await runPlates(project, report, { page: 1, panel: 'p1-2' })
    expect(events.filter((e) => e['event'] === 'plate').map((e) => e['status'])).toEqual(['cached', 'cached'])
  })

  it('paints each character into her own stand-in, in the plate, and keys the cache on the plate', async () => {
    const project = openProject(dir)
    const [plan] = await runPanels(project, report, { page: 1, panel: 'p1-2' })
    expect(plan!.request.plate?.hash).toBeDefined()
    expect(plan!.request.width).toBe(1024)
    expect(plan!.request.height).toBe(1536)
    expect(plan!.characterPrompts).toHaveLength(2)
    // The config's LoRA, not the one the script was written with: the config draws her.
    expect(plan!.characterPrompts![0]).toMatch(/<lora:ari_[a-z_]+v\d+:1\.2>/)
    expect(plan!.characterPrompts![0]).not.toContain('kvoss')
    expect(plan!.characterPrompts![1]).toContain('<lora:kvoss_v2:0.9>')

    // The stand-ins are gone and the sky is still the plate's.
    const png = PNG.sync.read(readFileSync(plan!.pngPath))
    const at = (fx: number, fy: number) => {
      const o = (Math.floor(fy * png.height) * png.width + Math.floor(fx * png.width)) * 4
      return [png.data[o], png.data[o + 1], png.data[o + 2]]
    }
    expect(at(0.3, 0.6)).not.toEqual([255, 0, 255])
    expect(at(0.7, 0.6)).not.toEqual([0, 255, 255])
    expect(at(0.5, 0.05)![2]).toBeGreaterThan(200)

    const sidecar = JSON.parse(readFileSync(plan!.sidecarPath, 'utf8'))
    expect(sidecar.request.plate.hash).toBe(plan!.request.plate!.hash)
    expect(Array.isArray(sidecar.backend_info) && sidecar.backend_info.length).toBe(2)

    events.length = 0
    await runPanels(project, report, { page: 1, panel: 'p1-2' })
    expect(events.some((e) => e['event'] === 'panel' && e['status'] === 'cached')).toBe(true)
  })

  it('renders an empty establishing shot straight from its plate', async () => {
    const project = openProject(dir)
    const [plan] = await runPanels(project, report, { page: 1, panel: 'p1-1' })
    expect(plan!.request.plate).toBeDefined()
    expect(plan!.request.width).toBe(1536)
    expect(existsSync(plan!.pngPath)).toBe(true)
  })

  it('asks twice more for a plate with no stand-in, then fails that panel and renders the rest', async () => {
    const project = openProject(dir)
    const done = await runPanels(project, report)
    expect(done.map((p) => p.id)).toEqual(['p1-1', 'p1-2'])
    const failures = events.filter((e) => e['event'] === 'plate' && e['status'] === 'failed')
    expect(failures).toHaveLength(3)
    expect(String(failures[0]!['message'])).toContain('no magenta stand-in')
    const panelFailed = events.find((e) => e['event'] === 'panel' && e['id'] === 'p1-3' && e['status'] === 'failed')
    expect(String(panelFailed!['message'])).toContain('never contained the stand-in')
    expect(existsSync(join(dir, 'panels', 'p1-3.png'))).toBe(false)
    expect(readPlateSidecar(platePaths(project, 'p1-3').sidecar)!.variation).toBe(2)
    process.exitCode = 0
  })
})
