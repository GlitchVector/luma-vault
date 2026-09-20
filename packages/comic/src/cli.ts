/**
 * `pnpm comic <command> <project> [flags]`
 *
 *   init      <project>                       start a project folder with an empty prose.md
 *   script    <project> [--prose file]        stage 1: prose -> script.json
 *   plates    <project> [--page N] [--panel ID|N] [--force]
 *                                             the hosted pass: a plate per panel, with stand-ins
 *   panels    <project> [--page N] [--panel ID|N] [--force] [--dry-run]
 *                                             stage 2: script.json -> panels/*.png
 *   render    <project> --page N --panel N [--seed S]
 *                                             stage 2 for one panel, always rendered
 *   qa        <project> [--page N] [--panel ID|N] [--no-retry] [--no-tagger]
 *                                             stage 4: inspect, retry failures
 *   assemble  <project> [--page N] [--format png,pdf,cbz]
 *                                             stage 3: pages, book.pdf, book.cbz
 *   all       <project>                       script -> panels -> qa -> assemble
 *   inspect   <project>                       settings in force, and which panels are out of date
 *   doctor    [project]                       what is reachable: Forge, LoRAs, tagger, Chrome
 *   layouts                                   the layout presets
 *
 * `--json` on any command turns the human lines into one JSON event per line
 * on stdout, which is what the desktop app reads.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { LAYOUTS } from './layouts.ts'
import { openProject, loadScript, type Project } from './project.ts'
import { ForgeRenderer } from './render/forge.ts'
import { Reporter } from './report.ts'
import { PythonTagger } from './qa/tagger.ts'
import { runAssemble } from './stages/assemble.ts'
import { loraNames, runPanels } from './stages/panels.ts'
import { runQa } from './stages/qa.ts'
import { inspect } from './stages/inspect.ts'
import { runScript } from './stages/script.ts'
import { plateBackendFor, platesEnabled, runPlates } from './stages/plates.ts'

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    page: { type: 'string' },
    panel: { type: 'string' },
    seed: { type: 'string' },
    attempt: { type: 'string' },
    prose: { type: 'string' },
    format: { type: 'string' },
    force: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'no-retry': { type: 'boolean', default: false },
    'no-tagger': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const [command, projectArg] = positionals
const report = new Reporter(values.json)

function usage(): never {
  console.error(
    `usage: comic <init|script|plates|panels|render|qa|assemble|all|inspect|doctor|layouts> <project> [flags]
  --page N        1-based page          --panel ID|N   a panel id (p2-3) or its number on --page
  --seed S        exact seed (render)   --attempt N    plan at this retry slot
  --prose FILE    story file (script)   --format LIST  png,pdf,cbz (assemble)
  --force         re-render cached      --dry-run      print the plan, render nothing
  --no-retry      qa inspects only      --no-tagger    qa without the figure counter
  --json          machine-readable events on stdout`,
  )
  process.exit(2)
}

function number(name: 'page' | 'seed' | 'attempt'): number | undefined {
  const raw = values[name]
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a whole number`)
  return value
}

function project(): Project {
  if (!projectArg) usage()
  return openProject(projectArg)
}

async function main(): Promise<void> {
  if (values.help || !command) usage()
  switch (command) {
    case 'init': {
      const p = project()
      if (!existsSync(p.prosePath)) {
        writeFileSync(p.prosePath, '# Title\n\nWrite the story here, as prose. Three paragraphs make a page.\n')
      }
      report.emit({ event: 'note', message: `project at ${p.dir}; write the story in ${p.prosePath}` })
      return
    }
    case 'script': {
      await runScript(project(), report, { prosePath: values.prose })
      return
    }
    case 'plates': {
      const p = project()
      if (!platesEnabled(p)) throw new Error('plates.backend is "none" in comic.config.json; set it to "openai" (or "mock") first')
      await runPlates(p, report, { page: number('page'), panel: values.panel }, { force: values.force })
      return
    }
    case 'panels': {
      await runPanels(project(), report, { page: number('page'), panel: values.panel }, {
        force: values.force,
        dryRun: values['dry-run'],
        attempt: number('attempt'),
        seed: number('seed'),
      })
      return
    }
    case 'render': {
      const page = number('page')
      if (page === undefined || !values.panel) throw new Error('render needs --page and --panel')
      await runPanels(project(), report, { page, panel: values.panel }, { force: true, seed: number('seed'), attempt: number('attempt') })
      return
    }
    case 'qa': {
      const verdicts = await runQa(project(), report, { page: number('page'), panel: values.panel }, {
        retry: !values['no-retry'],
        tagger: values['no-tagger'] ? null : undefined,
      })
      if (verdicts.some((v) => !v.ok)) process.exitCode = 1
      return
    }
    case 'assemble': {
      const formats = values.format?.split(',').map((f) => f.trim()) as Array<'png' | 'pdf' | 'cbz'> | undefined
      await runAssemble(project(), report, { page: number('page'), formats })
      return
    }
    case 'all': {
      const p = project()
      if (!existsSync(p.scriptPath)) await runScript(p, report)
      else report.emit({ event: 'note', message: `${p.scriptPath} exists, keeping it (delete it to rewrite)` })
      await runPanels(p, report)
      const verdicts = await runQa(p, report, {}, { tagger: values['no-tagger'] ? null : undefined })
      await runAssemble(p, report)
      if (verdicts.some((v) => !v.ok)) process.exitCode = 1
      return
    }
    case 'inspect': {
      // One JSON object on stdout rather than the event stream: this is a
      // question with an answer, not a stage with a running commentary.
      const result = inspect(project())
      if (values.json) console.log(JSON.stringify(result))
      else {
        const { settings } = result
        console.log(`renderer ${settings.renderer}, checkpoint ${settings.checkpoint}`)
        console.log(`page ${settings.pageWidth}x${settings.pageHeight} at scale ${settings.pageScale}`)
        console.log(`hires ${settings.hiresEnabled ? `on, denoise ${settings.hiresDenoise}` : 'off'}; plates ${settings.plates ? 'on' : 'off'}`)
        for (const panel of result.panels) {
          console.log(`${panel.id.padEnd(8)} ${panel.status}${panel.reason ? ` — ${panel.reason}` : ''}`)
        }
      }
      return
    }
    case 'doctor': {
      await doctor(projectArg ? openProject(projectArg) : undefined)
      return
    }
    case 'layouts': {
      for (const [name, layout] of Object.entries(LAYOUTS)) {
        console.log(`${name.padEnd(12)} ${layout.cells.length} panels  cols ${layout.columns}  rows ${layout.rows}`)
      }
      return
    }
    default:
      usage()
  }
}

async function doctor(p: Project | undefined): Promise<void> {
  const config = (p ?? openProject('.')).config
  const say = (ok: boolean, what: string) => console.log(`${ok ? ' ok ' : 'FAIL'}  ${what}`)

  const forge = new ForgeRenderer(config.forge)
  let loras: string[] = []
  if (p && existsSync(p.scriptPath)) {
    try {
      loras = loraNames(loadScript(p))
    } catch (error) {
      say(false, `script.json: ${(error as Error).message}`)
    }
  } else {
    loras = Object.values(config.characters).map((c) => c.lora.slice(0, c.lora.lastIndexOf(':')))
  }
  try {
    const prepared = await forge.prepare({ checkpoint: config.forge.checkpoint, loras })
    say(true, `Forge at ${config.forge.url}: checkpoint ${prepared.checkpoint}, LoRAs ${loras.join(', ') || '(none)'}`)
  } catch (error) {
    say(false, (error as Error).message)
  }

  const forPlates = p ?? openProject('.')
  if (platesEnabled(forPlates)) {
    try {
      await plateBackendFor(forPlates).prepare()
      say(true, `plates: ${config.plates.backend}, ${config.plates.model}`)
    } catch (error) {
      say(false, `plates: ${(error as Error).message}`)
    }
  } else {
    say(true, 'plates: off (each panel rendered directly)')
  }

  const tagger = new PythonTagger(config.qa)
  const why = tagger.available()
  say(!why, why ? `tagger: ${why}` : 'tagger: venv and model present')

  try {
    const { chromium } = await import('playwright-core')
    const browser = await chromium.launch(config.browser === 'chromium' ? { headless: true } : { channel: config.browser, headless: true })
    await browser.close()
    say(true, `browser: ${config.browser} starts`)
  } catch (error) {
    say(false, `browser: ${(error as Error).message.split('\n')[0]}`)
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  if (values.json) process.stdout.write(JSON.stringify({ event: 'stage', stage: command ?? '?', status: 'failed', message }) + '\n')
  console.error(`comic ${command ?? ''}: ${message}`)
  process.exit(1)
})
