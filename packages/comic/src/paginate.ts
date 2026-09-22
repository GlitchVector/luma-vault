/**
 * "Three paragraphs make a page." The template has said so since the first
 * comic, and nothing enforced it: the writer saw the prose as one block and
 * chose its own page count (the three-paragraph example became three pages).
 * So the prose is paged here, mechanically, before the writer sees it, and
 * the writer is told to keep exactly those pages.
 *
 * A leading `# Title` line stays a title. Paragraphs are blank-line
 * separated. A short story of one or two paragraphs is still one page.
 */

export const PARAGRAPHS_PER_PAGE = 3

export interface Paged {
  /** The prose with a `[Page N]` line before each page. */
  text: string
  /** How many pages the writer must produce. */
  pages: number
  title: string
}

export function paginate(prose: string, perPage = PARAGRAPHS_PER_PAGE): Paged {
  const lines = prose.trim().split('\n')
  let title = ''
  if (lines[0]?.startsWith('#')) title = lines.shift()!.replace(/^#+\s*/, '').trim()
  const paragraphs = lines
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const groups: string[][] = []
  for (let at = 0; at < paragraphs.length; at += perPage) groups.push(paragraphs.slice(at, at + perPage))
  const pages = Math.max(groups.length, 1)
  const body = groups.map((group, index) => `[Page ${index + 1}]\n\n${group.join('\n\n')}`).join('\n\n')
  return { text: `${title ? `# ${title}\n\n` : ''}${body}`, pages, title }
}
