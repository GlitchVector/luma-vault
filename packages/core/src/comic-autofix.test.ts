import { describe, expect, it } from 'vitest'
import { autofix, autofixCast, entryFor, loraNameOf, trainedWordsFrom } from './comic-autofix.ts'
import type { LoraEntry } from './loras.ts'
import type { ComicCharacter } from './comic.ts'

const entry = (patch: Partial<LoraEntry>): LoraEntry => ({
  name: 'ari_adopt_v4',
  trigger: 'ari',
  character: 'Ari',
  kind: 'full',
  description: 'her',
  status: 'final',
  weight: 1.2,
  olderVersions: ['ari_adopt_v1', 'ari_v1'],
  note: null,
  dataset: 'ari-adopt',
  outfit: null,
  parent: null,
  ...patch,
})

const character = (patch: Partial<ComicCharacter> = {}): ComicCharacter => ({
  lora: 'ari_adopt_v4:1.2',
  trigger: 'ari',
  look: '',
  head: '',
  body: '',
  subject: '1girl',
  seed_family: 8812,
  ...patch,
})

const catalogue = [entry({})]

describe('finding her in the catalogue', () => {
  it('matches the LoRA she is using', () => {
    expect(entryFor(character(), catalogue)?.name).toBe('ari_adopt_v4')
  })

  it('matches a version that has been superseded, which is the point', () => {
    expect(entryFor(character({ lora: 'ari_adopt_v1:1.2' }), catalogue)?.name).toBe('ari_adopt_v4')
  })

  it('falls back to the trigger for a comic written before the catalogue', () => {
    expect(entryFor(character({ lora: 'something_else:1' }), catalogue)?.name).toBe('ari_adopt_v4')
  })

  it('gives up rather than guessing when nothing matches', () => {
    expect(entryFor(character({ lora: 'nobody:1', trigger: 'nobody' }), catalogue)).toBeNull()
  })
})

describe('autofix', () => {
  it('moves a superseded version forward, at the catalogue weight', () => {
    const fixed = autofix(character({ lora: 'ari_adopt_v1:0.9' }), catalogue)
    expect(fixed.character.lora).toBe('ari_adopt_v4:1.2')
    expect(fixed.changes[0]).toMatch(/superseded/)
  })

  it('corrects a weight without calling it a version change', () => {
    const fixed = autofix(character({ lora: 'ari_adopt_v4:0.8' }), catalogue)
    expect(fixed.character.lora).toBe('ari_adopt_v4:1.2')
    expect(fixed.changes[0]).toMatch(/^weight/)
  })

  it('drops the look on a trigger-only LoRA, whose trigger already carries it', () => {
    const fixed = autofix(character({ look: 'aqua shirt, off-shoulder shirt, black collar, sneakers' }), catalogue)
    expect(fixed.character.look).toBe('')
    expect(fixed.changes.join(' ')).toMatch(/already carries it/)
  })

  it('KEEPS the look on an older LoRA, which was captioned with the outfit', () => {
    // `.ai/lora-training.md` § 5: the sheet-crop line dropped the identity
    // and kept the outfit, so those words are load-bearing.
    const old = [entry({ name: 'kvoss_v2', trigger: 'kvoss', status: 'wip', weight: 1, olderVersions: [] })]
    const fixed = autofix(character({ lora: 'kvoss_v2:1', trigger: 'kvoss', look: 'black hoodie, thong' }), old)
    expect(fixed.character.look).toBe('black hoodie, thong')
    expect(fixed.changes).toEqual([])
  })

  it('says so when an older LoRA has no outfit named, rather than rendering her bare', () => {
    const old = [entry({ name: 'kvoss_v2', trigger: 'kvoss', status: 'wip', olderVersions: [] })]
    const fixed = autofix(character({ lora: 'kvoss_v2:1', trigger: 'kvoss', look: '' }), old)
    expect(fixed.problem).toMatch(/has to be named/)
  })

  it('treats an outfit variant by how it was trained, not by its kind', () => {
    const wardrobe = [entry({ name: 'ari_gen_spacesuit', kind: 'outfit', outfit: 'space suit', status: 'final', olderVersions: [] })]
    const fixed = autofix(character({ lora: 'ari_gen_spacesuit:1', look: 'white suit' }), wardrobe)
    expect(fixed.character.look).toBe('')
  })

  it('says nothing when there is nothing to say', () => {
    expect(autofix(character(), catalogue).changes).toEqual([])
  })

  it('reports a character it cannot place rather than mangling her', () => {
    const fixed = autofix(character({ lora: 'nobody:1', trigger: 'nobody', look: 'a hat' }), catalogue)
    expect(fixed.problem).toMatch(/no LoRA in the catalogue/)
    expect(fixed.character.look).toBe('a hat')
  })
})

describe('a whole cast', () => {
  it('fixes each and names which one each change was', () => {
    const cast = {
      ari: character({ lora: 'ari_adopt_v1:1.2', look: 'aqua shirt' }),
      ghost: character({ lora: 'nobody:1', trigger: 'nobody' }),
    }
    const fixed = autofixCast(cast, catalogue)
    expect(fixed.characters['ari']!.lora).toBe('ari_adopt_v4:1.2')
    expect(fixed.changes.every((line) => line.startsWith('ari: '))).toBe(true)
    expect(fixed.problems[0]).toMatch(/^ghost: /)
  })
})

describe('reading a lora reference', () => {
  it('takes the name off the weight', () => {
    expect(loraNameOf('ari_adopt_v4:1.2')).toBe('ari_adopt_v4')
    expect(loraNameOf('plain')).toBe('plain')
  })
})

describe('against what the LoRA was actually captioned with', () => {
  // `ari_adopt_v4` really does carry two garment words: `white shorts` on 36
  // of 235 frames and `topless` on 40. The rest of her outfit appears zero
  // times. A captioned constant binds to its word and the trigger stops
  // owning it, so those two are load-bearing and the rest are noise.
  const trained = trainedWordsFrom([
    'ari, 1girl, solo, full body, standing, looking at viewer',
    'ari, 1girl, solo, full body, standing, topless, breasts out',
    'ari, 1girl, solo, cowboy shot, white shorts, topless',
  ])

  it('keeps a word it was taught and drops one it never saw', () => {
    const fixed = autofix(character({ look: 'aqua shirt, white shorts, black collar' }), catalogue, trained)
    expect(fixed.character.look).toBe('white shorts')
    expect(fixed.changes[0]).toMatch(/aqua shirt/)
    expect(fixed.changes[0]).toMatch(/kept white shorts/)
  })

  it('leaves a look alone when every word was taught', () => {
    const fixed = autofix(character({ look: 'white shorts' }), catalogue, trained)
    expect(fixed.character.look).toBe('white shorts')
    expect(fixed.changes).toEqual([])
  })

  it('is case-insensitive, because a caption is not a spelling test', () => {
    const fixed = autofix(character({ look: 'White Shorts' }), catalogue, trained)
    expect(fixed.character.look).toBe('White Shorts')
  })

  it('falls back to the status when the captions are not on this machine', () => {
    const fixed = autofix(character({ look: 'aqua shirt, white shorts' }), catalogue, null)
    expect(fixed.character.look).toBe('')
  })

  it('reads a caption pile into the words it contains', () => {
    expect([...trainedWordsFrom(['a, B ,, c'])].sort()).toEqual(['a', 'b', 'c'])
  })
})
