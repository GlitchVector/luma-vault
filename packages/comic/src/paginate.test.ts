import { describe, expect, it } from 'vitest'
import { paginate } from './paginate.ts'

describe('paginate', () => {
  it('makes a page of every three paragraphs and keeps the title', () => {
    const prose = '# Lost in Space\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n'
    const paged = paginate(prose)
    expect(paged.title).toBe('Lost in Space')
    expect(paged.pages).toBe(2)
    expect(paged.text).toBe('# Lost in Space\n\n[Page 1]\n\nOne.\n\nTwo.\n\nThree.\n\n[Page 2]\n\nFour.')
  })

  it('is one page for a short story, and for prose without a title', () => {
    expect(paginate('Only one paragraph.')).toEqual({ text: '[Page 1]\n\nOnly one paragraph.', pages: 1, title: '' })
    expect(paginate('A.\n\n\n\nB.').pages).toBe(1)
  })

  it('treats a lone newline inside a paragraph as the same paragraph', () => {
    const paged = paginate('# T\n\nline one\nline two\n\nsecond paragraph')
    expect(paged.pages).toBe(1)
    expect(paged.text).toContain('line one\nline two')
  })
})

describe('storyboard pages', () => {
  it('cuts at the page headings and keeps every panel line', () => {
    const board = '# Beanpole\n\n## Page 1\n\n1. Wide: the roof. — Caption: "Hotel roof."\n2. Close: her face.\n3. Him, shouting. — Man: "Beanpole!"\n4. Her hand on her wrist.\n\n## Page 2\n\n1. The farm at dawn.'
    const paged = paginate(board)
    expect(paged.pages).toBe(2)
    expect(paged.title).toBe('Beanpole')
    expect(paged.text).toContain('[Page 1]\n\n1. Wide: the roof.')
    expect(paged.text).toContain('4. Her hand on her wrist.\n\n[Page 2]')
  })
})
