/**
 * Stage 1: prose in, `script.json` out.
 *
 * The writer produces a draft — pages and panels only. This stage validates
 * it, gives it its ids, and merges in the cast from the config, so nothing
 * the model says can change which LoRA a character is or which seed family
 * she draws from. One retry with the validation errors attached: a model
 * that disagreed with the schema once usually agrees the second time.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { defaultLayoutFor } from '../layouts.ts'
import { paginate } from '../paginate.ts'
import { REPO_ROOT, formatIssues, panelId, writeJson, type Project } from '../project.ts'
import type { Reporter } from '../report.ts'
import { draftScriptSchema, type Character, type DraftScript, type Page, type Script } from '../schema.ts'
import { AnthropicWriter } from '../writer/anthropic.ts'
import { systemBrief } from '../writer/brief.ts'
import { ClaudeCliWriter } from '../writer/claude-cli.ts'
import type { Writer } from '../writer/writer.ts'

export function writerFor(backend: 'claude-cli' | 'anthropic'): Writer {
  return backend === 'anthropic' ? new AnthropicWriter() : new ClaudeCliWriter()
}

export async function runScript(
  project: Project,
  report: Reporter,
  options: { writer?: Writer; prosePath?: string } = {},
): Promise<Script> {
  const prosePath = options.prosePath ?? project.prosePath
  if (!existsSync(prosePath)) throw new Error(`${prosePath} does not exist — write the story there first`)
  const written = readFileSync(prosePath, 'utf8').trim()
  if (!written) throw new Error(`${prosePath} is empty`)
  // Three paragraphs make a page: cut here, and hold the writer to it.
  const paged = paginate(written)
  const prose = paged.text

  const writer = options.writer ?? writerFor(project.config.writer.backend)
  // Draft 7 without the `$schema` line: the CLI's validator rejects the
  // 2020-12 dialect zod emits by default, by refusing the URL it names.
  const { $schema: _dialect, ...schema } = z.toJSONSchema(draftScriptSchema, { target: 'draft-7' }) as Record<string, unknown>
  const system = systemBrief(project.config.characters)
  report.emit({ event: 'stage', stage: 'script', status: 'start', message: `${writer.name}, ${project.config.writer.model}` })

  let prompt = prose
  let draft: Finished | undefined
  let lastError = ''
  for (let round = 0; round < 2 && !draft; round++) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await writer.write({ system, prompt, schema, model: project.config.writer.model })
    const parsed = draftScriptSchema.safeParse(raw)
    if (parsed.success) {
      try {
        draft = finishDraft(parsed.data, project.config.characters)
        if (draft.pages.length !== paged.pages) {
          lastError = `the prose is cut into ${paged.pages} page(s) ([Page N] lines) but the script has ${draft.pages.length}; make exactly ${paged.pages}, in order`
          draft = undefined
        }
      } catch (error) {
        lastError = (error as Error).message
      }
    } else {
      lastError = formatIssues(parsed.error.issues)
    }
    if (!draft) {
      report.emit({ event: 'note', message: `the draft did not validate, asking again:\n${lastError}` })
      prompt = `${prose}\n\nYour previous answer was rejected for these reasons; fix them and answer again:\n${lastError}`
    }
  }
  if (!draft) throw new Error(`the writer could not produce a valid script:\n${lastError}`)

  const script = withCast(draft, project.config.characters)
  writeJson(project.scriptPath, script)
  report.emit({ event: 'output', kind: 'script', path: project.scriptPath })
  for (const line of vocabularyNotes(script)) report.emit({ event: 'note', message: line })
  report.emit({ event: 'stage', stage: 'script', status: 'done' })
  return script
}

/**
 * Ids assigned by position, layouts filled in, and every reference checked
 * against the cast — so a `--panel 2` later means the second panel of the
 * page and nothing the model chose to call it.
 */
export function finishDraft(draft: DraftScript, cast: Record<string, Character>): Finished {
  const pages: Page[] = draft.pages.map((page, pageIndex) => {
    const layout = page.layout ?? defaultLayoutFor(page.panels.length)
    const panels = page.panels.map((panel, panelIndex) => {
      const id = panelId(pageIndex + 1, panelIndex + 1)
      for (const who of panel.characters) {
        if (!cast[who]) throw new Error(`${id} names character "${who}", which comic.config.json does not define`)
      }
      for (const line of panel.dialogue) {
        if (line.speaker !== 'narrator' && !cast[line.speaker]) {
          throw new Error(`${id} has dialogue for "${line.speaker}", who is not in the cast`)
        }
      }
      if (panel.location && !draft.locations[panel.location]) {
        throw new Error(`${id} is set in "${panel.location}", which is not in locations`)
      }
      // Lettering with nowhere reserved is the one thing QA cannot rescue.
      const reserve = panel.reserve_space === 'none' && panel.dialogue.length > 0 ? panel.dialogue[0]!.anchor : panel.reserve_space
      return { ...panel, id, reserve_space: reserve }
    })
    return { ...page, layout, panels }
  })
  return { ...draft, pages }
}

export interface Finished {
  title: string
  locations: Record<string, string>
  pages: Page[]
}

export function withCast(draft: Finished, cast: Record<string, Character>): Script {
  const used = new Set<string>()
  for (const page of draft.pages) {
    for (const panel of page.panels) {
      for (const who of panel.characters) used.add(who)
      for (const line of panel.dialogue) if (line.speaker !== 'narrator') used.add(line.speaker)
    }
  }
  const characters: Record<string, Character> = {}
  for (const id of used) characters[id] = cast[id]!
  // A story with nobody on screen still needs a seed family for its shots.
  if (used.size === 0) {
    const first = Object.entries(cast)[0]
    if (first) characters[first[0]] = first[1]
  }
  return { title: draft.title, characters, locations: draft.locations, pages: draft.pages }
}

/**
 * Words in the camera and scene fields that the tagger's vocabulary does not
 * contain. A note, not an error: absence is not proof a word is inert, but a
 * scene built from words the checkpoint never saw is the first thing to look
 * at when a panel comes out wrong.
 */
export function vocabularyNotes(script: Script, csvPath = join(REPO_ROOT, 'models', 'anime-tagger', 'selected_tags.csv')): string[] {
  if (!existsSync(csvPath)) return []
  const known = new Set<string>()
  for (const line of readFileSync(csvPath, 'utf8').split('\n').slice(1)) {
    const name = line.split(',')[1]
    if (name) known.add(name.trim().replaceAll('_', ' '))
  }
  const unknown: string[] = []
  let total = 0
  for (const page of script.pages) {
    for (const panel of page.panels) {
      for (const raw of `${panel.camera}, ${panel.scene}`.split(',')) {
        const term = raw.trim().replace(/^\(+/, '').replace(/:[\d.]+\)+$/, '').replace(/\)+$/, '').toLowerCase()
        if (!term) continue
        total += 1
        if (!known.has(term) && !unknown.includes(term)) unknown.push(term)
      }
    }
  }
  if (unknown.length === 0) return []
  // One line, not one per panel: the count is the signal, the examples say
  // whether the writer drifted into prose.
  const shown = unknown.slice(0, 8).join(', ')
  return [`${unknown.length} of ${total} scene terms are not tags the checkpoint was trained on, e.g. ${shown}${unknown.length > 8 ? ', ...' : ''}`]
}
