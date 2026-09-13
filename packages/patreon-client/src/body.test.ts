import { describe, expect, it } from 'vitest'
import { BodyError, renderBody } from './body.ts'

const doc = (source: string) => JSON.parse(renderBody(source).contentJsonString)
const ATTRS = { nodeIndent: null, nodeTextAlignment: null, nodeLineHeight: null, style: '' }

describe('renderBody', () => {
  // The captured document, reproduced exactly. This is the test that would fail
  // if somebody "tidied" the paragraph attrs or renamed the bold mark to the
  // `strong` a ProseMirror schema would default to — which is what it is called
  // in the HTML half, and is not what the editor sends in the document half.
  it('reproduces the captured document, marks and all', () => {
    expect(doc('one paragraph\n\nsecond **paragraph** and a [link](https://github.com/)')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: ATTRS, content: [{ type: 'text', text: 'one paragraph' }] },
        {
          type: 'paragraph',
          attrs: ATTRS,
          content: [
            { type: 'text', text: 'second ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'paragraph' },
            { type: 'text', text: ' and a ' },
            {
              type: 'text',
              marks: [{ type: 'link', attrs: { href: 'https://github.com/', target: '_blank', auto: false } }],
              text: 'link',
            },
          ],
        },
      ],
    })
  })

  it('emits the HTML half the editor sends beside it', () => {
    expect(renderBody('paragraph **two** and a [link](https://github.com/)').content).toBe(
      '<p>paragraph <strong>two</strong> and a <a href="https://github.com/">link</a></p>',
    )
  })

  // An empty paragraph arrives with no `content` key at all, not with an empty
  // array. Copied from the capture rather than guessed.
  it('omits content entirely on an empty paragraph', () => {
    const empty = doc('')
    expect(empty.content).toEqual([{ type: 'paragraph', attrs: ATTRS }])
    expect('content' in empty.content[0]).toBe(false)
    expect(renderBody('').content).toBe('<p></p>')
  })

  it('breaks paragraphs on blank lines only', () => {
    expect(doc('one\ntwo').content).toHaveLength(1)
    expect(doc('one\n\ntwo').content).toHaveLength(2)
    expect(doc('one\ntwo').content[0].content[0].text).toBe('one two')
  })

  // A photoset body is written by hand and pasted around; an unescaped angle
  // bracket in the HTML half would be markup the author did not write.
  it('escapes HTML in the text, without touching the document half', () => {
    expect(renderBody('a < b & "c"').content).toBe('<p>a &lt; b &amp; &quot;c&quot;</p>')
    expect(doc('a < b & "c"').content[0].content[0].text).toBe('a < b & "c"')
  })

  it('refuses a link scheme that has no business in a post body', () => {
    expect(() => renderBody('[click](javascript:alert(1))')).toThrow(BodyError)
    expect(() => renderBody('[mail](mailto:someone@example.com)')).not.toThrow()
  })

  // Italic is not supported because no capture says whether the mark is called
  // `italic` or `em`, and a mark the editor does not know fails quietly. Until
  // one capture settles it, an asterisk is an asterisk.
  it('leaves a single asterisk as literal text rather than guessing the italic mark', () => {
    const node = doc('an *emphasised* word').content[0].content[0]
    expect(node.text).toBe('an *emphasised* word')
    expect(node.marks).toBeUndefined()
  })

  it('keeps bold and links apart when they sit next to each other', () => {
    const parts = doc('**a**[b](https://x.test/)').content[0].content
    expect(parts.map((p: { text: string }) => p.text)).toEqual(['a', 'b'])
    expect(parts[0].marks[0].type).toBe('bold')
    expect(parts[1].marks[0].type).toBe('link')
  })

  it('round-trips a body that is only text', () => {
    expect(doc('just words').content[0].content).toEqual([{ type: 'text', text: 'just words' }])
  })
})
