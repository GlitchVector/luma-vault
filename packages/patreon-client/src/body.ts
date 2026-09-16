/**
 * The post body, in the two forms the editor sends side by side.
 *
 * `data.attributes.content` is HTML. `data.attributes.content_json_string` is
 * the editor's own document — a ProseMirror/TipTap tree — JSON-encoded *into a
 * string*. Both go on the same PATCH, so both are built here from one source.
 *
 * Every shape below is copied from a capture rather than from what ProseMirror
 * usually does, and the difference bit once already: the bold mark is `bold`,
 * not the `strong` a ProseMirror schema would default to. The paragraph attrs
 * are carried verbatim for the same reason — they are always these four values
 * in every capture, and inventing a shorter paragraph node is a change nothing
 * here has evidence is safe.
 *
 * WHAT IS SUPPORTED: paragraphs, **bold**, and [links](https://…). That is
 * exactly what has been captured. Italic is deliberately absent — TipTap calls
 * it `italic` and ProseMirror calls it `em`, no capture says which, and a mark
 * the editor does not recognise is the kind of thing that fails quietly. One
 * capture with an italic word settles it; until then `*` is literal text.
 */

/** What goes onto the PATCH. */
export interface RenderedBody {
  /** `data.attributes.content` — HTML. */
  readonly content: string
  /** `data.attributes.content_json_string` — the document, already stringified. */
  readonly contentJsonString: string
}

/** Paragraph attrs, verbatim from every capture. */
const PARAGRAPH_ATTRS = {
  nodeIndent: null,
  nodeTextAlignment: null,
  nodeLineHeight: null,
  style: '',
} as const

interface TextNode {
  type: 'text'
  text: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

interface ParagraphNode {
  type: 'paragraph'
  attrs: typeof PARAGRAPH_ATTRS
  /** Omitted entirely when the paragraph is empty — that is how the editor sends it. */
  content?: TextNode[]
}

/** Only schemes a post body has any business linking to. */
const SAFE_SCHEME = /^(https?:|mailto:)/i

export class BodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BodyError'
  }
}

export function renderBody(source: string): RenderedBody {
  const paragraphs = splitParagraphs(source)
  const nodes: ParagraphNode[] = paragraphs.map((text) => {
    const parts = parseInline(text)
    return parts.length === 0
      ? { type: 'paragraph', attrs: PARAGRAPH_ATTRS }
      : { type: 'paragraph', attrs: PARAGRAPH_ATTRS, content: parts }
  })

  return {
    content: nodes.map(toHtml).join(''),
    contentJsonString: JSON.stringify({ type: 'doc', content: nodes }),
  }
}

/**
 * Blank lines separate paragraphs; a single newline does not.
 *
 * A body with no text still produces one empty paragraph, because that is what
 * the editor sends for an untouched post and a `doc` with no content is not a
 * shape any capture shows.
 */
function splitParagraphs(source: string): string[] {
  const blocks = source
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\n/g, ' ').trim())
  const kept = blocks.filter((block, at) => block !== '' || at === blocks.length - 1)
  return kept.length === 0 ? [''] : kept
}

/**
 * `**bold**` and `[text](href)`, and nothing else.
 *
 * Deliberately not a markdown parser. The body of a photoset post is a few
 * sentences; pulling in a parser would bring a schema this editor does not have
 * — headings, lists, images — and every one of those would have to be either
 * mapped to something or silently dropped.
 */
function parseInline(text: string): TextNode[] {
  const nodes: TextNode[] = []
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g
  let at = 0

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > at) push(nodes, text.slice(at, match.index))

    const [, bold, linkText, href] = match
    if (bold !== undefined) {
      push(nodes, bold, [{ type: 'bold' }])
    } else if (linkText !== undefined && href !== undefined) {
      if (!SAFE_SCHEME.test(href)) {
        throw new BodyError(`link to ${href}: only http, https and mailto links are allowed in a post body`)
      }
      // target and auto are part of the captured mark, not decoration.
      push(nodes, linkText, [{ type: 'link', attrs: { href, target: '_blank', auto: false } }])
    }
    at = match.index + match[0].length
  }

  if (at < text.length) push(nodes, text.slice(at))
  return nodes
}

function push(nodes: TextNode[], text: string, marks?: TextNode['marks']): void {
  if (text === '') return
  nodes.push(marks === undefined ? { type: 'text', text } : { type: 'text', text, marks })
}

function toHtml(node: ParagraphNode): string {
  const inner = (node.content ?? [])
    .map((part) => {
      const escaped = escapeHtml(part.text)
      const mark = part.marks?.[0]
      if (mark?.type === 'bold') return `<strong>${escaped}</strong>`
      if (mark?.type === 'link') return `<a href="${escapeHtml(String(mark.attrs?.['href'] ?? ''))}">${escaped}</a>`
      return escaped
    })
    .join('')
  return `<p>${inner}</p>`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
