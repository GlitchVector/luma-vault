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

/** A storyboard page starts with `## Page N`: its panels are already planned. */
const PAGE_HEADING = /^##\s*Page\s+\d+\b.*$/im

export function paginate(prose: string, perPage = PARAGRAPHS_PER_PAGE): Paged {
  const lines = prose.trim().split('\n')
  let title = ''
  if (lines[0]?.startsWith('# ')) title = lines.shift()!.replace(/^#+\s*/, '').trim()
  // Storyboards (owner, 2026-09-24): prose chopped into panels read as "no
  // sense", so /comic writes each page as its panels. Such a page is cut at
  // its heading, however many lines it has, and passed through whole.
  const rest = lines.join('\n').trim()
  if (PAGE_HEADING.test(rest)) {
    const pages = rest
      .split(/^(?=##\s*Page\s+\d+)/im)
      .map((page) => page.replace(/^##\s*Page\s+\d+.*\n?/i, '').trim())
      .filter(Boolean)
    const body = pages.map((page, index) => `[Page ${index + 1}]\n\n${page}`).join('\n\n')
    return { text: `${title ? `# ${title}\n\n` : ''}${body}`, pages: pages.length, title }
  }
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
