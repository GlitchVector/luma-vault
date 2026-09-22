/**
 * The development plan: what is still missing about a character, in the
 * order the facets depend on each other.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STEPS, isEmpty } from './facets.ts'
import { formatPlan, nextAsk, openProposals, plan } from './plan.ts'
import { addSheets } from './sheets.ts'
import type { Studio } from './root.ts'

let root: string
let studio: Studio

function facet(name: string, body: string) {
  writeFileSync(join(root, 'characters', 'ari', `${name}.md`), body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-plan-'))
  mkdirSync(join(root, 'characters', 'ari', 'proposals'), { recursive: true })
  studio = { root, config: { model: { backend: 'claude-cli', url: '', model: '', api_key_env: '', temperature: 0.9 }, proposals: 5 } }
  for (const step of STEPS) facet(step.facet, `# Ari — ${step.facet}\n\n_Nothing established yet._\n`)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('what counts as empty', () => {
  it('ignores the heading and the stub italics', () => {
    expect(isEmpty('# Ari — personality\n\n_Nothing established yet._\n')).toBe(true)
    expect(isEmpty('')).toBe(true)
  })

  it('counts one real line as developed', () => {
    expect(isEmpty('# Ari — personality\n\n- She apologises by doing you a favour.\n')).toBe(false)
  })
})

describe('the plan', () => {
  it('starts at personality, because everything is downstream of it', () => {
    const found = plan(studio, 'ari')
    expect(found.next?.facet).toBe('personality')
    expect(found.next?.asks.length).toBeGreaterThan(1)
  })

  it('moves on only when a facet has something in it', () => {
    facet('personality', '# p\n\n- She gets louder when embarrassed.\n')
    expect(plan(studio, 'ari').next?.facet).toBe('speech')
  })

  it('keeps the dependency order rather than the alphabet', () => {
    const order = STEPS.map((step) => step.facet)
    expect(order.indexOf('speech')).toBeGreaterThan(order.indexOf('personality'))
    expect(order.indexOf('relationships')).toBeGreaterThan(order.indexOf('history'))
    // The only per-story facet, so it waits for everything about her.
    expect(order.at(-1)).toBe('current_state')
    // It reads as a checklist before she is someone.
    expect(order.indexOf('sexuality')).toBeGreaterThan(order.indexOf('personality'))
  })

  it('says when there is nothing left rather than inventing a step', () => {
    for (const step of STEPS) facet(step.facet, `# x\n\n- something\n`)
    const found = plan(studio, 'ari')
    expect(found.next).toBeNull()
    expect(formatPlan(found)).toMatch(/every facet has something in it/)
  })
})

describe('proposals waiting', () => {
  it('lists only files with an item still unticked', () => {
    const dir = join(root, 'characters', 'ari', 'proposals')
    writeFileSync(join(dir, '20260918-a.md'), '# Proposals\n\n- [ ] 1. **Open**\n')
    writeFileSync(join(dir, '20260919-b.md'), '# Proposals\n\n- [x] 1. **Approved**\n')
    expect(openProposals(studio, 'ari')).toEqual(['20260918-a.md'])
  })

  it('puts them in front of the person before the next ask', () => {
    writeFileSync(join(root, 'characters', 'ari', 'proposals', '20260918-a.md'), '- [ ] 1. **Open**\n')
    expect(formatPlan(plan(studio, 'ari'))).toMatch(/proposals waiting on you/)
  })
})

describe('the next question', () => {
  it('is the first ask of the first empty facet', () => {
    const step = nextAsk(studio, 'ari')
    expect(step?.facet).toBe('personality')
    expect(step?.ask).toBe(STEPS[0]!.asks[0])
  })

  it('skips an ask that already has a proposals file, answered or not', () => {
    // He has seen those options. Asking again buries the file he still owes
    // an answer to.
    const slug = STEPS[0]!.asks[0]!.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)
    writeFileSync(join(root, 'characters', 'ari', 'proposals', `20260918-${slug}.md`), '- [ ] 1. **x**\n')
    expect(nextAsk(studio, 'ari')?.ask).toBe(STEPS[0]!.asks[1])
  })

  it('moves to the next facet once one is written', () => {
    facet('personality', '# p\n\n- something true\n')
    expect(nextAsk(studio, 'ari')?.facet).toBe('speech')
  })

  it('is null when every facet has something in it', () => {
    for (const step of STEPS) facet(step.facet, '# x\n\n- something\n')
    expect(nextAsk(studio, 'ari')).toBeNull()
  })
})

describe('sheets', () => {
  it('files a picture against her and lists it in the plan', () => {
    const from = join(root, 'sheet.png')
    writeFileSync(from, 'not really a png, but it has the extension')
    expect(addSheets(studio, 'ari', [from]).added).toHaveLength(1)
    expect(plan(studio, 'ari').sheets).toHaveLength(1)
    expect(formatPlan(plan(studio, 'ari'))).toMatch(/sheet\(s\) to look at/)
  })

  it('keeps both when two sheets share a name', () => {
    const a = join(root, 'a', 'sheet.png')
    const b = join(root, 'b', 'sheet.png')
    mkdirSync(join(root, 'a'), { recursive: true })
    mkdirSync(join(root, 'b'), { recursive: true })
    writeFileSync(a, 'one')
    writeFileSync(b, 'two')
    addSheets(studio, 'ari', [a, b])
    expect(plan(studio, 'ari').sheets).toHaveLength(2)
  })

  it('refuses what is not a picture rather than filing it', () => {
    const notes = join(root, 'notes.txt')
    writeFileSync(notes, 'words')
    const result = addSheets(studio, 'ari', [notes, join(root, 'missing.png')])
    expect(result.added).toEqual([])
    expect(result.skipped).toHaveLength(2)
  })
})

describe('the facets that need a compliant model', () => {
  it('marks sexuality and boundaries, and nothing else', () => {
    const explicit = STEPS.filter((step) => step.explicit).map((step) => step.facet)
    expect(explicit).toEqual(['sexuality', 'boundaries'])
  })

  it('carries the mark through the plan and the next ask', () => {
    for (const step of STEPS) {
      if (step.facet !== 'sexuality') facet(step.facet, '# x\n\n- something\n')
    }
    const step = nextAsk(studio, 'ari')
    expect(step?.facet).toBe('sexuality')
    expect(step?.explicit).toBe(true)
    expect(formatPlan(plan(studio, 'ari'))).toMatch(/does not refuse adult material/)
  })
})
