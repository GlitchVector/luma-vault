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

/** A storyboard item: its text starts with numbered panels. */
const STORYBOARD = /^\*\*[^*]+\*\*\s*1\.\s/

/**
 * Approved items only: a `**Title.** text` item becomes its text, a page's
 * paragraphs stay paragraphs. When the approved pages are storyboards, each
 * becomes a `## Page N` block with its panel lines, which the pipeline cuts
 * at the heading and follows panel for panel.
 */
export function proseFromStory(storyMd: string, title: string): string {
  const items = storyMd.split(/^## Approved .*$/m).map((item) => item.trim()).filter((item) => item && !NOTE.test(item) && !/^# /.test(item))
  if (items.length > 0 && items.every((item) => STORYBOARD.test(item))) {
    const pages = items.map((item, index) => `## Page ${index + 1}\n\n${item.replace(/^\*\*[^*]+\*\*\s*/, '').trim()}`)
    return `# ${title}\n\n${pages.join('\n\n')}\n`
  }
  const paragraphs = storyMd
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && !HEADING.test(block) && !NOTE.test(block))
    .map((block) => block.replace(/^\*\*[^*]+\*\*\s*/, ''))
    .filter(Boolean)
  return `# ${title}\n\n${paragraphs.join('\n\n')}\n`
}
