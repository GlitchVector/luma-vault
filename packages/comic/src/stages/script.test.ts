import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openProject } from '../project.ts'
import { Reporter } from '../report.ts'
import { extractJson } from '../writer/writer.ts'
import type { Writer, WriterInput } from '../writer/writer.ts'
import { runScript, vocabularyNotes } from './script.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'comic-script-'))
  writeFileSync(join(dir, 'prose.md'), 'Ari climbs to the roof at dawn.\n\nShe finds a lost drone.\n\nIt follows her home.')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const quiet = new Reporter(true)

class ScriptedWriter implements Writer {
  readonly name = 'scripted'
  readonly prompts: string[] = []
  private readonly answers: unknown[]
  constructor(answers: unknown[]) {
    this.answers = answers
  }
  async write(input: WriterInput): Promise<unknown> {
    this.prompts.push(input.prompt)
    const answer = this.answers.shift()
    if (answer === undefined) throw new Error('no answer left')
    return answer
  }
}

const goodDraft = {
  title: 'First Light',
  pages: [
    {
      panels: [
        { id: 'whatever', camera: 'wide shot', scene: 'rooftop, dawn', characters: ['ari'], reserve_space: 'top', dialogue: [], sfx: [] },
        {
          id: 'x',
          camera: 'close-up',
          scene: 'drone in hand',
          characters: ['ari'],
          reserve_space: 'none',
          dialogue: [{ speaker: 'ari', text: 'Hello, little one.', anchor: 'top-right' }],
          sfx: [],
        },
      ],
    },
  ],
}

describe('stage 1', () => {
  it('ids the panels by position, fills the layout, reserves space where the balloon goes, and merges the cast', async () => {
    const script = await runScript(openProject(dir), quiet, { writer: new ScriptedWriter([goodDraft]) })
    const page = script.pages[0]!
    expect(page.layout).toBe('two-stack')
    expect(page.panels.map((p) => p.id)).toEqual(['p1-1', 'p1-2'])
    expect(page.panels[1]!.reserve_space).toBe('top-right')
    expect(script.characters['ari']).toMatchObject({ lora: 'ari_adopt_v1:1.2', trigger: 'ari', seed_family: 8812 })
    const onDisk = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'))
    expect(onDisk.title).toBe('First Light')
  })

  it('sends the validation errors back once, then gives up', async () => {
    const bad = { title: 'x', pages: [{ panels: [{ camera: 'x', scene: 'y', characters: ['bob'] }] }] }
    const writer = new ScriptedWriter([bad, goodDraft])
    await runScript(openProject(dir), quiet, { writer })
    expect(writer.prompts).toHaveLength(2)
    expect(writer.prompts[1]).toMatch(/rejected.*"bob"/s)

    const stubborn = new ScriptedWriter([bad, bad])
    await expect(runScript(openProject(dir), quiet, { writer: stubborn })).rejects.toThrow(/could not produce a valid script/)
  })

  it('refuses an empty story', async () => {
    writeFileSync(join(dir, 'prose.md'), '   ')
    await expect(runScript(openProject(dir), quiet, { writer: new ScriptedWriter([goodDraft]) })).rejects.toThrow(/is empty/)
  })

  it('notes words outside the tag vocabulary, and stays silent without the vocabulary', () => {
    const csv = join(dir, 'tags.csv')
    writeFileSync(csv, 'tag_id,name,category,count\n1,rooftop,0,10\n2,close-up,0,10\n')
    const script = {
      title: 't',
      characters: {},
      locations: {},
      pages: [{ layout: 'splash', panels: [{ id: 'p1-1', camera: 'close-up', scene: 'rooftop, (vaporwave:1.2)', pose: [], characters: [], reserve_space: 'none' as const, dialogue: [], sfx: [] }] }],
    }
    expect(vocabularyNotes(script, csv)).toEqual(['1 of 3 scene terms are not tags the checkpoint was trained on, e.g. vaporwave'])
    expect(vocabularyNotes(script, join(dir, 'missing.csv'))).toEqual([])
  })
})

describe('extractJson', () => {
  it('reads a fenced block, a bare object, and an object with braces in strings', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('Sure: {"a":{"b":"}"}} done')).toEqual({ a: { b: '}' } })
    expect(() => extractJson('no json here')).toThrow(/no JSON object/)
  })
})
