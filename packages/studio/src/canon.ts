/**
 * Proposed versus canonical, kept apart by where they are written.
 *
 * A brainstorm writes a numbered proposals file. `approve` copies the
 * numbers a person picked into the canon file they named, under a dated
 * heading that says where they came from, and marks the proposal file so
 * the same item is not approved twice. Nothing else writes canon.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHARACTER_FILES, characterDir, comicDir, readText, writeText, type CharacterFile, type Studio } from './root.ts'

export interface Proposal {
  n: number
  title: string
  text: string
  /** `approved` once copied somewhere; `passed` once explicitly declined. */
  state: 'open' | 'approved' | 'passed'
}

export interface ProposalFile {
  path: string
  ask: string
  proposals: Proposal[]
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ask'
}

export function proposalsDir(studio: Studio, target: { character: string } | { comic: string }): string {
  return 'character' in target ? join(characterDir(studio, target.character), 'proposals') : join(comicDir(studio, target.comic), 'proposals')
}

/** The proposals file as Markdown a person can read and edit. */
export function formatProposals(ask: string, proposals: Array<{ title: string; text: string }>): string {
  const items = proposals.map((p, i) => `- [ ] ${i + 1}. **${p.title}**\n\n  ${p.text.trim().replace(/\n/g, '\n  ')}`).join('\n\n')
  return `# Proposals\n\nAsk: ${ask}\n\n${items}\n`
}

export function writeProposals(studio: Studio, target: { character: string } | { comic: string }, ask: string, proposals: Array<{ title: string; text: string }>): string {
  const path = join(proposalsDir(studio, target), `${stamp()}-${slug(ask)}.md`)
  writeText(path, formatProposals(ask, proposals))
  return path
}

export function parseProposals(path: string): ProposalFile {
  const text = readText(path)
  const ask = text.match(/^Ask: (.*)$/m)?.[1] ?? ''
  const proposals: Proposal[] = []
  // One chunk per list item; the head line carries the mark, number and
  // title, everything after it (indented) is the body.
  for (const chunk of text.split(/\n(?=- \[[ x-]\] \d+\. )/)) {
    const match = chunk.match(/^- \[( |x|-)\] (\d+)\. \*\*(.*?)\*\*\n\n([\s\S]*)$/)
    if (!match) continue
    const [, mark, n, title, body] = match
    proposals.push({
      n: Number(n),
      title: title!,
      text: body!.replace(/^  /gm, '').trim(),
      state: mark === 'x' ? 'approved' : mark === '-' ? 'passed' : 'open',
    })
  }
  return { path, ask, proposals }
}

/** `latest`, a file name, or a path. */
export function resolveProposals(studio: Studio, target: { character: string } | { comic: string }, which: string): string {
  if (existsSync(which)) return which
  const dir = proposalsDir(studio, target)
  if (which === 'latest') {
    const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : []
    const last = files.at(-1)
    if (!last) throw new Error(`no proposals in ${dir} yet — brainstorm first`)
    return join(dir, last)
  }
  const named = join(dir, which.endsWith('.md') ? which : `${which}.md`)
  if (existsSync(named)) return named
  throw new Error(`no proposals file "${which}" in ${dir}`)
}

function markProposals(file: ProposalFile, numbers: number[], mark: 'x' | '-'): void {
  let text = readFileSync(file.path, 'utf8')
  for (const n of numbers) {
    text = text.replace(new RegExp(`^- \\[ \\] ${n}\\. `, 'm'), `- [${mark}] ${n}. `)
  }
  writeText(file.path, text)
}

export function canonTarget(studio: Studio, target: { character: string } | { comic: string }, into: string): string {
  if ('character' in target) {
    if (!CHARACTER_FILES.includes(into as CharacterFile)) {
      throw new Error(`"${into}" is not a character file; one of ${CHARACTER_FILES.join(', ')}`)
    }
    return join(characterDir(studio, target.character), `${into}.md`)
  }
  const allowed = ['concept', 'outline', 'story', 'continuity']
  if (!allowed.includes(into)) throw new Error(`"${into}" is not a comic document; one of ${allowed.join(', ')}`)
  return join(comicDir(studio, target.comic), `${into}.md`)
}

/**
 * Copy the picked proposals into a canon file. Returns what was written.
 * A proposal already approved or passed is refused by number, so the person
 * sees it rather than getting a silent duplicate.
 */
export function approve(studio: Studio, target: { character: string } | { comic: string }, which: string, numbers: number[], into: string): { file: string; added: Proposal[] } {
  const file = parseProposals(resolveProposals(studio, target, which))
  const picked: Proposal[] = []
  for (const n of numbers) {
    const proposal = file.proposals.find((p) => p.n === n)
    if (!proposal) throw new Error(`there is no proposal ${n} in ${file.path}`)
    if (proposal.state !== 'open') throw new Error(`proposal ${n} was already ${proposal.state}`)
    picked.push(proposal)
  }
  const canon = canonTarget(studio, target, into)
  const existing = readText(canon).replace(/\n*_Nothing established yet\.[^\n]*_\n?/, '\n')
  const date = new Date().toISOString().slice(0, 10)
  const heading = `\n## Approved ${date} (from ${file.path.split(/[\\/]/).pop()})\n\n`
  const body = picked.map((p) => `**${p.title}.** ${p.text}`).join('\n\n') + '\n'
  writeText(canon, existing.replace(/\n*$/, '\n') + heading + body)
  markProposals(file, numbers, 'x')
  return { file: canon, added: picked }
}

export function pass(studio: Studio, target: { character: string } | { comic: string }, which: string, numbers: number[]): void {
  const file = parseProposals(resolveProposals(studio, target, which))
  markProposals(file, numbers, '-')
}
