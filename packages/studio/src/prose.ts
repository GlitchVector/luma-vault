/**
 * The comic's story, as the picture pipeline wants it: `# Title`, then the
 * approved paragraphs in order, nothing else. `story.md` is a canon file
 * like any other — dated headings, bold proposal titles, italic notes — and
 * `prose.md` in a comic project must be plain prose, because the writer
 * reads it as the story and the template's rule (three paragraphs make a
 * page) counts paragraphs.
 */

const HEADING = /^#/
const NOTE = /^_.*_$/

/** Approved items only: a `**Title.** text` item becomes its text, a page's paragraphs stay paragraphs. */
export function proseFromStory(storyMd: string, title: string): string {
  const paragraphs = storyMd
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !HEADING.test(block) && !NOTE.test(block))
    .map((block) => block.replace(/^\*\*[^*]+\*\*\s*/, ''))
    .filter(Boolean)
  return `# ${title}\n\n${paragraphs.join('\n\n')}\n`
}
