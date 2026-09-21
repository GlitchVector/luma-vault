/**
 * Collecting a comic into the vault as a set.
 *
 * The rules worth pinning are the ones a re-render would otherwise break: a
 * comic keeps ONE set however many times it is redrawn, and a panel keeps
 * its place in that set when it is replaced.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openProject } from '../project.ts'
import { Reporter } from '../report.ts'
import type { Script } from '../schema.ts'
import { collect, dayFolder, mergeMembers, runIdFor, slug, type SetManifest } from './collect.ts'

const panel = (id: string) => ({
  id,
  camera: 'cowboy shot',
  scene: 'rooftop',
  pose: [],
  characters: ['ari'],
  reserve_space: 'none' as const,
  dialogue: [],
  sfx: [],
})

const script: Script = {
  title: 'First Light',
  characters: {
    ari: { lora: 'ari_adopt_v4:1.2', trigger: 'ari', look: 'white hair', head: '', body: '', subject: '1girl', seed_family: 8812 },
  },
  locations: {},
  pages: [{ layout: 'two-stack', panels: [panel('p1-1'), panel('p1-2')] }],
}

let dir: string
let vault: string
const quiet = new Reporter(true)

function project() {
  writeFileSync(join(dir, 'comic.config.json'), JSON.stringify({ renderer: 'mock' }))
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script))
  return openProject(dir)
}

function pretendRendered(open: ReturnType<typeof openProject>, ids: string[], pages: string[] = []) {
  mkdirSync(open.panelsDir, { recursive: true })
  mkdirSync(open.outDir, { recursive: true })
  for (const id of ids) writeFileSync(join(open.panelsDir, `${id}.png`), id)
  for (const name of pages) writeFileSync(join(open.outDir, name), name)
}

function manifestIn(): SetManifest {
  const day = join(vault, dayFolder())
  const path = join(day, '.luma-sets', `${slug('comic-' + dir.split(/[\\/]/).filter(Boolean).at(-1))}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as SetManifest
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comic-collect-'))
  vault = mkdtempSync(join(tmpdir(), 'comic-vault-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(vault, { recursive: true, force: true })
})

describe('collecting', () => {
  it('copies the panels and the pages, and labels each one', () => {
    const open = project()
    pretendRendered(open, ['p1-1', 'p1-2'], ['page-01.png'])
    expect(collect(open, script, quiet, { outdir: vault })).toBe(3)

    const manifest = manifestIn()
    expect(manifest.command).toBe('comic')
    expect(manifest.title).toBe('First Light')
    // One character in the cast, so the sidebar can file it under her.
    expect(manifest.character).toBe('ari')
    expect(manifest.members.map((m) => m.label)).toEqual([
      'p1-1 · cowboy shot',
      'p1-2 · cowboy shot',
      'page 1',
    ])
    // Members are bare names resolved against the manifest's own folder.
    expect(manifest.members.every((m) => !m.file.includes('/') && !m.file.includes('\\'))).toBe(true)
    for (const member of manifest.members) {
      expect(existsSync(join(vault, dayFolder(), member.file))).toBe(true)
    }
  })

  it('keeps one set across re-renders rather than making a new one each time', () => {
    const open = project()
    pretendRendered(open, ['p1-1', 'p1-2'], ['page-01.png'])
    collect(open, script, quiet, { outdir: vault })
    const first = manifestIn()

    writeFileSync(join(open.panelsDir, 'p1-1.png'), 'redrawn')
    collect(open, script, quiet, { outdir: vault })
    const second = manifestIn()

    expect(second.run).toBe(first.run)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.members).toHaveLength(first.members.length)
    expect(readFileSync(join(vault, dayFolder(), second.members[0]!.file), 'utf8')).toBe('redrawn')
  })

  it('says nothing and does nothing without a folder to write to', () => {
    const open = project()
    pretendRendered(open, ['p1-1'])
    expect(collect(open, script, quiet, {})).toBe(0)
    expect(collect(open, script, quiet, { outdir: join(vault, 'nope') })).toBe(0)
  })

  it('skips panels that were never rendered instead of naming missing files', () => {
    const open = project()
    pretendRendered(open, ['p1-2'])
    expect(collect(open, script, quiet, { outdir: vault })).toBe(1)
    expect(manifestIn().members.map((m) => m.label)).toEqual(['p1-2 · cowboy shot'])
  })
})

describe('the set id', () => {
  it('is the comic, not the moment, so a re-render does not litter the sidebar', () => {
    const open = project()
    expect(runIdFor(open)).toBe(slug(`comic-${open.name}`))
    expect(runIdFor(open)).toMatch(/^comic-/)
  })
})

describe('merging members', () => {
  it('replaces a picture in place and appends a new one', () => {
    const before = [{ file: 'a.png', label: 'one' }, { file: 'b.png', label: 'two' }]
    const after = mergeMembers(before, [{ file: 'b.png', label: 'two, redrawn' }, { file: 'c.png', label: 'three' }])
    expect(after.map((m) => m.file)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(after[1]!.label).toBe('two, redrawn')
  })
})
