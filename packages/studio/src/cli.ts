/**
 * `pnpm studio <command> …`
 *
 *   init [root] [--no-ari]                     lay out a content root (default D:\Development\comic-studio)
 *   status [comic]                             what exists and where it stands
 *   context <task> …                           print what the model would be shown
 *
 *   character new <id> --name "…"
 *   character brainstorm <id> "<ask>" [--count N]      proposals → characters/<id>/proposals/
 *   character approve <id> <file|latest> <n,n> --into <file>
 *   character pass <id> <file|latest> <n,n>
 *
 *   comic new <id> --title "…" --characters ari,maya
 *   story brainstorm <comic> "<ask>" [--count N]       proposals → comics/<id>/proposals/
 *   story approve <comic> <file|latest> <n,n> --into concept|outline|story|continuity
 *   scene draft <comic> "<approved direction>"         → scenes/scene_NNN.yaml (status planned)
 *   panels plan <comic> <scene_NNN> [--count N]        → panels/panel_NNN.yaml (PLANNED)
 *   direct <comic> <panel_NNN> "<instruction>" [--dry-run]
 *   lock <comic> <panel_NNN> <name…> / unlock …
 *   state <comic> <panel_NNN> <STATE>                  the person moves a panel; REVIEW → APPROVED is only ever this
 *   export <comic> [dir]                               → a comic project for `pnpm comic panels <dir>`
 *   continuity <comic> [scene_NNN|panel_NNN]           warnings, never edits
 *   cliches <comic> <scene_NNN|panel_NNN>              criticism, never edits
 *
 * The model never writes canon. Proposals are files; `approve` copies the
 * picked ones into the file you name, and that is the only way in.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import {
  CLICHE_BRIEF,
  CLICHE_JSON_SCHEMA,
  CONTINUITY_BRIEF,
  CONTINUITY_JSON_SCHEMA,
  PANELS_JSON_SCHEMA,
  PROPOSALS_JSON_SCHEMA,
  SCENE_JSON_SCHEMA,
  characterBrief,
  panelsBrief,
  sceneBrief,
  storyBrief,
} from './briefs.ts'
import { approve, pass, writeProposals } from './canon.ts'
import { assemble, render, type Task } from './context.ts'
import { defaultExportDir, exportComic } from './export.ts'
import { DIRECTOR_BRIEF, PATCH_JSON_SCHEMA, applyPatch, describe, lockPath, patchReplySchema } from './director.ts'
import { ClaudeCliModel } from './model/claude-cli.ts'
import { extractJson, type StoryModel } from './model/model.ts'
import { OpenAiCompatibleModel } from './model/openai-compatible.ts'
import { formatPlan, nextAsk, openProposals, plan } from './plan.ts'
import { addSheets, listSheets } from './sheets.ts'
import { assertId, comicDir, initStudio, openStudio, resolveUserPath, scaffoldCharacter, studioRoot, writeText, type Studio } from './root.ts'
import { seedAri } from './seed-ari.ts'
import {
  PANEL_STATES,
  listIds,
  nextId,
  panelStateSchema,
  readComic,
  readPanel,
  readScene,
  sceneSchema,
  writeComic,
  writePanel,
  writeScene,
  panelSchema,
} from './spec.ts'
import { comicStatus, formatStatus, overview } from './status.ts'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    root: { type: 'string' },
    name: { type: 'string' },
    title: { type: 'string' },
    characters: { type: 'string' },
    into: { type: 'string' },
    count: { type: 'string' },
    /** Repeatable: character sheets to file against a character. */
    sheet: { type: 'string', multiple: true },
    force: { type: 'boolean', default: false },
    'no-ari': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

function usage(): never {
  console.error(
    `usage: studio <init|status|model|plan|context|character|comic|story|scene|panels|direct|lock|unlock|state|export|continuity|cliches> …
  init [root] [--no-ari]            character new <id> --name "…"
  status [comic]                    character next <id> [--force]   the wizard: next question, asked
  plan <character>                  character sheets <id> [--sheet <path>…]
  model                             which model answers, whether it can, and what it offers
  plan <character>                  character brainstorm <id> "<ask>" [--count N]
  context <task> …                  character approve <id> <file|latest> <n,n> --into <file>
  comic new <id> --title "…" --characters a,b
  story brainstorm <comic> "<ask>"  story approve <comic> <file|latest> <n,n> --into concept|outline|story|continuity
  scene draft <comic> "<direction>" panels plan <comic> <scene_NNN> [--count N]
  direct <comic> <panel> "<instruction>" [--dry-run]     lock|unlock <comic> <panel> <name…>
  state <comic> <panel> <STATE>     export <comic> [dir]                 cliches <comic> <scene|panel>
  continuity <comic> [scene|panel]
  --root <dir> overrides STUDIO_ROOT`,
  )
  process.exit(2)
}

function modelFor(studio: Studio): StoryModel {
  const m = studio.config.model
  return m.backend === 'openai-compatible' ? new OpenAiCompatibleModel(m) : new ClaudeCliModel(m.model)
}

function numbers(spec: string | undefined): number[] {
  if (!spec) usage()
  const list = spec.split(',').map((s) => Number(s.trim()))
  if (list.some((n) => !Number.isInteger(n) || n < 1)) throw new Error(`"${spec}" is not a list of proposal numbers`)
  return list
}

function count(studio: Studio): number {
  const n = values.count ? Number(values.count) : studio.config.proposals
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('--count must be 1 to 20')
  return n
}

function need(index: number, what: string): string {
  const value = positionals[index]
  if (!value) {
    console.error(`missing ${what}`)
    usage()
  }
  return value
}

async function ask<T>(studio: Studio, task: Task, system: string, user: string, schema: Record<string, unknown>, parse: z.ZodType<T>): Promise<T> {
  const model = modelFor(studio)
  const context = render(assemble(studio, task))
  console.error(`[${model.name}] ${task.kind}${context ? ` with ${assemble(studio, task).length} context block(s)` : ' with no context'}`)
  const reply = await model.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: `${context ? `CONTEXT\n\n${context}\n\n` : ''}TASK\n\n${user}` },
    ],
    { json: schema },
  )
  const parsed = parse.safeParse(extractJson(reply))
  if (!parsed.success) throw new Error(`the model's answer did not fit: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return parsed.data
}

const proposalsSchema = z.object({ proposals: z.array(z.object({ title: z.string(), text: z.string() })).min(1) })

async function main(): Promise<void> {
  const [command, sub] = positionals
  if (values.help || !command) usage()

  if (command === 'init') {
    const root = studioRoot(positionals[1] ?? values.root)
    const made = initStudio(root)
    const studio = openStudio(root)
    const ari = values['no-ari'] ? [] : seedAri(studio)
    console.log(`studio at ${root}`)
    for (const f of [...made, ...ari]) console.log(`  + ${f}`)
    if (made.length + ari.length === 0) console.log('  (already laid out; nothing overwritten)')
    return
  }

  const studio = openStudio(values.root)

  switch (command) {
    case 'status': {
      if (sub) console.log(formatStatus(comicStatus(studio, sub)))
      else console.log(overview(studio))
      return
    }
    case 'model': {
      // Which model answers, and whether it can. Worth its own command
      // because the alternative is finding out through a failed brainstorm
      // after the context has been assembled.
      const m = studio.config.model
      console.log(`backend : ${m.backend}`)
      if (m.backend === 'claude-cli') {
        console.log(`model   : ${m.model}`)
        console.log('note    : the fallback. It refuses explicit material, so it is only useful for')
        console.log('          the non-explicit facets.')
        return
      }
      const remote = !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(m.url)
      const key = process.env[m.api_key_env]
      console.log(`url     : ${m.url}${remote ? '  (someone else\'s server)' : '  (this machine)'}`)
      console.log(`model   : ${m.model}`)
      console.log(`key     : ${m.api_key_env} ${key ? 'is set' : remote ? 'is NOT set — put it in the repo .env' : 'not needed'}`)
      if (remote && !key) return
      // What it actually offers, so nobody guesses a model name.
      try {
        const response = await fetch(`${m.url.replace(/\/+$/, '')}/models`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) {
          console.log(`models  : ${m.url}/models answered ${response.status}`)
          return
        }
        const list = (await response.json()) as { data?: Array<{ id?: string }> }
        const names = (list.data ?? []).map((entry) => entry.id).filter(Boolean)
        console.log(`models  : ${names.length ? names.join(', ') : '(none reported)'}`)
        if (names.length > 0 && !names.includes(m.model)) {
          console.log(`          ! "${m.model}" is not among them`)
        }
      } catch (error) {
        console.log(`models  : could not ask — ${(error as Error).message}`)
      }
      return
    }
    case 'plan': {
      // What is still to develop about a character, and the asks to develop
      // it with. The order comes from `facets.ts`, so this and the app's
      // character page cannot disagree about what is next.
      console.log(formatPlan(plan(studio, need(1, 'a character id'))))
      return
    }
    case 'context': {
      const task = taskFromArgs(positionals.slice(1))
      console.log(render(assemble(studio, task)) || '(no context: every relevant file is still a stub)')
      return
    }
    case 'character': {
      const id = need(2, 'character id')
      assertId(id, 'character')
      switch (sub) {
        case 'new': {
          const made = scaffoldCharacter(studio, id, values.name ?? id)
          for (const f of made) console.log(`  + ${f}`)
          return
        }
        case 'brainstorm': {
          const topic = need(3, 'what to brainstorm')
          const n = count(studio)
          const reply = await ask(studio, { kind: 'character.brainstorm', character: id }, characterBrief(id, n), topic, PROPOSALS_JSON_SCHEMA(n), proposalsSchema)
          const path = writeProposals(studio, { character: id }, topic, reply.proposals)
          console.log(`${reply.proposals.length} proposals → ${path}\n`)
          reply.proposals.forEach((p, i) => console.log(`${i + 1}. ${p.title}\n   ${p.text.replace(/\n/g, '\n   ')}\n`))
          console.log(`approve with: pnpm studio character approve ${id} latest <n,n> --into <${'core|personality|history|…'}>`)
          return
        }
        case 'sheets': {
          // The pictures she is developed from, filed with her. The text
          // model cannot see them; a person or a vision-capable assistant
          // reads them and writes what they see into a proposal.
          const given = values.sheet ?? []
          if (given.length > 0) {
            const { added, skipped } = addSheets(studio, id, given)
            for (const path of added) console.log(`  + ${path}`)
            for (const why of skipped) console.log(`  ! ${why}`)
          }
          const sheets = listSheets(studio, id)
          if (sheets.length === 0) {
            console.log(`no sheets for ${id}. Add one: pnpm studio character sheets ${id} --sheet <path> [--sheet <path>]`)
            return
          }
          console.log(`${sheets.length} sheet(s) for ${id}:`)
          for (const path of sheets) console.log(`  ${path}`)
          console.log('\nThe story model is text only and cannot see these. Open them, then write what you see')
          console.log('into appearance or outfits as a proposal.')
          return
        }
        case 'next': {
          // The wizard in one step: work out what is still missing, ask that
          // question, and print the approve line for the answer. Splitting
          // "what next" from "ask it" only made two commands to remember.
          const waiting = openProposals(studio, id)
          if (waiting.length > 0 && !values.force) {
            console.log(`${waiting.length} proposal file(s) still waiting on you:`)
            for (const name of waiting) console.log(`  ${name}`)
            console.log('\nApprove or pass from those first, or pass --force to ask anyway.')
            return
          }
          const step = nextAsk(studio, id)
          if (!step) {
            console.log(formatPlan(plan(studio, id)))
            return
          }
          if (step.explicit && studio.config.model.backend === 'claude-cli') {
            // A refusal from the fallback comes back shaped like an answer
            // and is written into a proposals file as though it were one.
            console.error(`${step.facet} needs a model that does not refuse adult material, and the backend is claude-cli.`)
            console.error('Point studio.config.json at the local model or at xAI, then try again. See: pnpm studio model')
            process.exitCode = 1
            return
          }
          const n = count(studio)
          console.log(`${step.facet} — ${step.ask}\n`)
          const reply = await ask(studio, { kind: 'character.brainstorm', character: id }, characterBrief(id, n), step.ask, PROPOSALS_JSON_SCHEMA(n), proposalsSchema)
          const path = writeProposals(studio, { character: id }, step.ask, reply.proposals)
          console.log(`${reply.proposals.length} proposals → ${path}\n`)
          reply.proposals.forEach((p, i) => console.log(`${i + 1}. ${p.title}\n   ${p.text.replace(/\n/g, '\n   ')}\n`))
          console.log(`approve with: pnpm studio character approve ${id} latest <n,n> --into ${step.facet}`)
          return
        }
        case 'approve': {
          const result = approve(studio, { character: id }, need(3, 'proposals file'), numbers(positionals[4]), values.into ?? usage())
          console.log(`${result.added.length} added to ${result.file}:`)
          for (const p of result.added) console.log(`  ✓ ${p.n}. ${p.title}`)
          return
        }
        case 'pass': {
          pass(studio, { character: id }, need(3, 'proposals file'), numbers(positionals[4]))
          console.log('marked as passed')
          return
        }
        default:
          usage()
      }
    }
    // fallthrough is unreachable: every case above returns or exits
    case 'comic': {
      if (sub !== 'new') usage()
      const id = need(2, 'comic id')
      assertId(id, 'comic')
      if (existsSync(join(comicDir(studio, id), 'comic.yaml'))) throw new Error(`comic "${id}" exists`)
      const characters = (values.characters ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      for (const c of characters) if (!existsSync(join(studio.root, 'characters', c))) throw new Error(`no character "${c}" — character new ${c} first`)
      writeComic(studio, { id, title: values.title ?? '', characters, concept: 'draft', outline: 'draft' })
      for (const doc of ['concept', 'outline', 'story', 'continuity']) {
        writeText(join(comicDir(studio, id), `${doc}.md`), `# ${values.title ?? id} — ${doc}\n\n_Nothing established yet._\n`)
      }
      for (const dir of ['scenes', 'panels', 'proposals', 'generations', 'approved', 'final']) writeText(join(comicDir(studio, id), dir, '.keep'), '')
      console.log(`comic ${id} at ${comicDir(studio, id)}`)
      return
    }
    case 'story': {
      const comic = need(2, 'comic id')
      readComic(studio, comic)
      switch (sub) {
        case 'brainstorm': {
          const topic = need(3, 'what to brainstorm')
          const n = count(studio)
          const reply = await ask(studio, { kind: 'story.brainstorm', comic }, storyBrief(comic, n), topic, PROPOSALS_JSON_SCHEMA(n), proposalsSchema)
          const path = writeProposals(studio, { comic }, topic, reply.proposals)
          console.log(`${reply.proposals.length} proposals → ${path}\n`)
          reply.proposals.forEach((p, i) => console.log(`${i + 1}. ${p.title}\n   ${p.text.replace(/\n/g, '\n   ')}\n`))
          console.log(`approve with: pnpm studio story approve ${comic} latest <n,n> --into outline|story|concept`)
          return
        }
        case 'approve': {
          const result = approve(studio, { comic }, need(3, 'proposals file'), numbers(positionals[4]), values.into ?? usage())
          console.log(`${result.added.length} added to ${result.file}`)
          return
        }
        case 'pass': {
          pass(studio, { comic }, need(3, 'proposals file'), numbers(positionals[4]))
          console.log('marked as passed')
          return
        }
        default:
          usage()
      }
    }
    case 'scene': {
      if (sub !== 'draft') usage()
      const comic = need(2, 'comic id')
      readComic(studio, comic)
      const direction = need(3, 'the approved direction')
      const draft = await ask(studio, { kind: 'scene.draft', comic }, sceneBrief(comic), direction, SCENE_JSON_SCHEMA, sceneSchema.omit({ id: true, status: true }))
      const id = nextId(listIds(studio, comic, 'scenes'), 'scene')
      const scene = sceneSchema.parse({ ...draft, id, status: 'planned', notes: `direction: ${direction}` })
      writeScene(studio, comic, scene)
      console.log(`${id} → comics/${comic}/scenes/${id}.yaml\n`)
      console.log(`${scene.title}\npurpose: ${scene.purpose}\nlocation: ${scene.location}\ncharacters: ${scene.characters.join(', ')}\nbeats:`)
      scene.beats.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
      if (scene.continuity_changes.length) console.log(`continuity changes:\n  - ${scene.continuity_changes.join('\n  - ')}`)
      console.log('\nedit the file freely; then: pnpm studio continuity', comic, id)
      return
    }
    case 'panels': {
      if (sub !== 'plan') usage()
      const comic = need(2, 'comic id')
      const sceneId = need(3, 'scene id')
      const scene = readScene(studio, comic, sceneId)
      const wanted = values.count ? Number(values.count) : undefined
      const reply = await ask(
        studio,
        { kind: 'panels.plan', comic, scene: sceneId },
        panelsBrief(wanted),
        `Plan the panels for ${sceneId}${wanted ? ` (${wanted} panels)` : ''}.`,
        PANELS_JSON_SCHEMA,
        z.object({ panels: z.array(z.record(z.string(), z.unknown())).min(1) }),
      )
      const ids = listIds(studio, comic, 'panels')
      const made: string[] = []
      for (const proposed of reply.panels) {
        const id = nextId([...ids, ...made], 'panel')
        const { beat, ...rest } = proposed
        const panel = panelSchema.parse({ ...rest, id, scene: sceneId, status: 'PLANNED', locked: [], notes: typeof beat === 'string' ? `beat: ${beat}` : undefined })
        for (const who of Object.keys(panel.characters)) {
          if (!scene.characters.includes(who)) throw new Error(`the model put "${who}" in ${id}, who is not in ${sceneId}`)
        }
        writePanel(studio, comic, panel)
        made.push(id)
        console.log(`${id}: ${panel.story_function}\n   ${panel.camera.framing ?? ''} ${panel.camera.angle ?? ''} · ${Object.entries(panel.characters).map(([w, c]) => `${w} ${c.screen_position ?? ''} ${c.pose ?? ''}`).join(' · ')}`)
      }
      console.log(`\n${made.length} panels planned. Direct one with: pnpm studio direct ${comic} ${made[0]} "…"`)
      return
    }
    case 'direct': {
      const comic = need(1, 'comic id')
      const panelId = need(2, 'panel id')
      const instruction = need(3, 'the instruction')
      const panel = readPanel(studio, comic, panelId)
      const reply = await ask(
        studio,
        { kind: 'direct', comic, panel: panelId },
        `${DIRECTOR_BRIEF}\n\nLocked (do not change): ${panel.locked.length ? panel.locked.map((l) => lockPath(l, Object.keys(panel.characters))).join(', ') : 'nothing'}`,
        instruction,
        PATCH_JSON_SCHEMA,
        patchReplySchema,
      )
      const applied = applyPatch(panel, reply, instruction)
      console.log(describe(applied))
      if (reply.note) console.log(`note: ${reply.note}`)
      if (values['dry-run']) {
        console.log('(dry run: nothing written)')
        return
      }
      writePanel(studio, comic, applied.panel)
      return
    }
    case 'lock':
    case 'unlock': {
      const comic = need(1, 'comic id')
      const panelId = need(2, 'panel id')
      const names = positionals.slice(3)
      if (names.length === 0) usage()
      const panel = readPanel(studio, comic, panelId)
      const characters = Object.keys(panel.characters)
      const paths = names.map((n) => lockPath(n, characters))
      const locked = panel.locked.map((l) => lockPath(l, characters))
      panel.locked = command === 'lock' ? [...new Set([...locked, ...paths])] : locked.filter((l) => !paths.includes(l))
      writePanel(studio, comic, panel)
      console.log(`locked: ${panel.locked.join(', ') || 'nothing'}`)
      return
    }
    case 'state': {
      const comic = need(1, 'comic id')
      const panelId = need(2, 'panel id')
      const state = panelStateSchema.safeParse(need(3, 'state'))
      if (!state.success) throw new Error(`state must be one of ${PANEL_STATES.join(', ')}`)
      const panel = readPanel(studio, comic, panelId)
      const before = panel.status
      panel.status = state.data
      writePanel(studio, comic, panel)
      console.log(`${panelId}: ${before} → ${state.data}`)
      return
    }
    case 'export': {
      const comic = need(1, 'comic id')
      const dir = positionals[2] ? resolveUserPath(positionals[2]) : defaultExportDir(studio, comic)
      const done = exportComic(studio, comic, dir, { perPage: values.count ? Number(values.count) : undefined })
      console.log(`${done.panels} panels on ${done.pages} page(s) → ${done.dir}`)
      console.log(`cast: ${done.characters.join(', ') || '(nobody)'}`)
      for (const s of done.skipped) console.log(`  skipped ${s.id}: ${s.why}`)
      if (done.vagueLocations.length > 0) {
        console.log(`
these places have no prompt words, so their scenes were scraped out of prose:`)
        for (const id of done.vagueLocations) console.log(`  locations/${id}.md — add a line: prompt_words: rooftop, city, night, …`)
      }
      console.log(`
render it with:
  pnpm comic panels ${done.dir}
  pnpm comic assemble ${done.dir}`)
      return
    }
    case 'continuity': {
      const comic = need(1, 'comic id')
      const target = positionals[2]
      const task: Task = { kind: 'continuity', comic, scene: target?.startsWith('scene_') ? target : undefined, panel: target?.startsWith('panel_') ? target : undefined }
      const reply = await ask(
        studio,
        task,
        CONTINUITY_BRIEF,
        target ? `Check ${target} against the canon.` : 'Check the comic documents against the canon.',
        CONTINUITY_JSON_SCHEMA,
        z.object({ warnings: z.array(z.object({ where: z.string(), canon: z.string(), conflict: z.string(), severity: z.string() })) }),
      )
      if (reply.warnings.length === 0) {
        console.log('No continuity warnings.')
        return
      }
      for (const w of reply.warnings) {
        console.log(`CONTINUITY ${w.severity.toUpperCase()}: ${w.where}\n  canon: ${w.canon}\n  here:  ${w.conflict}\n`)
      }
      console.log('Keep the canon, change the document, or change the canon on purpose — your call; nothing was edited.')
      process.exitCode = 1
      return
    }
    case 'cliches': {
      const comic = need(1, 'comic id')
      const target = need(2, 'scene or panel id')
      const task: Task = target.startsWith('scene_') ? { kind: 'story.brainstorm', comic } : { kind: 'dialogue', comic, panel: target }
      const doc = target.startsWith('scene_') ? readScene(studio, comic, target) : readPanel(studio, comic, target)
      const reply = await ask(
        studio,
        task,
        CLICHE_BRIEF,
        `Critique this:\n\n${JSON.stringify(doc, null, 2)}`,
        CLICHE_JSON_SCHEMA,
        z.object({ findings: z.array(z.object({ where: z.string(), kind: z.string(), why: z.string() })) }),
      )
      if (reply.findings.length === 0) console.log('Nothing generic found.')
      for (const f of reply.findings) console.log(`${f.kind}: ${f.where}\n  ${f.why}\n`)
      return
    }
    default:
      usage()
  }
}

function taskFromArgs(args: string[]): Task {
  const [kind, a, b] = args
  switch (kind) {
    case 'character.brainstorm':
      return { kind, character: a ?? usage() }
    case 'story.brainstorm':
    case 'scene.draft':
      return { kind, comic: a ?? usage() }
    case 'panels.plan':
      return { kind, comic: a ?? usage(), scene: b ?? usage() }
    case 'direct':
    case 'dialogue':
      return { kind, comic: a ?? usage(), panel: b ?? usage() }
    case 'continuity':
      return { kind, comic: a ?? usage(), scene: b?.startsWith('scene_') ? b : undefined, panel: b?.startsWith('panel_') ? b : undefined }
    default:
      console.error('tasks: character.brainstorm <id> | story.brainstorm <comic> | scene.draft <comic> | panels.plan <comic> <scene> | direct <comic> <panel> | dialogue <comic> <panel> | continuity <comic> [scene|panel]')
      return usage()
  }
}

main().catch((error: unknown) => {
  console.error(`studio: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
