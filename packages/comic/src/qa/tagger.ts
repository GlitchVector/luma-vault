/**
 * Figure counting through the vault's own tagger (wd-vit-tagger-v3), run on
 * the CPU by the classifier venv.
 *
 * The tagger is the one local model that can say how many people are in a
 * picture — `solo`, `2girls`, `multiple girls`, `no humans` — and whether it
 * drew a turnaround instead of a person (`multiple views`). It also carries
 * the few anatomy tags danbooru has; they fire rarely and are taken as hard
 * failures when they do. It runs on the CPU so it can inspect while the GPU
 * trains.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PACKAGE_DIR, REPO_ROOT } from '../project.ts'
import type { QaConfig } from '../schema.ts'

export type Tags = Record<string, number>

/** Tags reported whatever their confidence, because the figure rules read
 *  them against each other rather than against the threshold. */
export const WATCH_TAGS = [
  'solo',
  '1girl',
  '1boy',
  '2girls',
  '2boys',
  'multiple girls',
  'multiple boys',
  'no humans',
  'multiple views',
  'bad anatomy',
  'bad hands',
  'extra arms',
  'extra legs',
  'deformed',
  'speech bubble',
]

export interface Tagger {
  tag(paths: string[]): Promise<Map<string, Tags>>
}

export class PythonTagger implements Tagger {
  private readonly python: string
  private readonly modelDir: string
  private readonly threshold: number

  constructor(config: Pick<QaConfig, 'python' | 'tagger_dir' | 'tag_threshold'>) {
    this.python = resolve(REPO_ROOT, config.python)
    this.modelDir = resolve(REPO_ROOT, config.tagger_dir)
    this.threshold = config.tag_threshold
  }

  available(): string | null {
    if (!existsSync(this.python)) return `${this.python} does not exist (run pnpm setup:python)`
    if (!existsSync(join(this.modelDir, 'model.onnx'))) return `${this.modelDir} has no model.onnx (run pnpm setup:python)`
    return null
  }

  async tag(paths: string[]): Promise<Map<string, Tags>> {
    const why = this.available()
    if (why) throw new Error(`the tagger is not available: ${why}`)
    if (paths.length === 0) return new Map()
    const script = join(PACKAGE_DIR, 'src', 'qa', 'tagger.py')
    const args = [script, '--model-dir', this.modelDir, '--threshold', String(this.threshold), '--watch', WATCH_TAGS.join(','), ...paths]
    const { stdout, stderr, code } = await run(this.python, args)
    if (code !== 0) throw new Error(`tagger exited with ${code}: ${stderr.trim().slice(-800)}`)
    const result = new Map<string, Tags>()
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as { path: string; tags: Tags }
      result.set(row.path, row.tags)
    }
    return result
  }
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolvePromise({ stdout, stderr, code: code ?? -1 }))
  })
}

/**
 * The figure verdict, from the tags. Hard failures only: the count is off, or
 * the model drew a reference sheet, or an anatomy tag fired.
 */
export function judgeFigures(tags: Tags, expected: number, threshold: number): string[] {
  const at = (name: string) => tags[name] ?? 0
  const failures: string[] = []
  const several = Math.max(at('2girls'), at('2boys'), at('multiple girls'), at('multiple boys'))
  const nobody = at('no humans')
  const one = Math.max(at('1girl'), at('1boy'))

  if (expected === 0) {
    if (one >= threshold || several >= threshold) failures.push('figures: expected nobody, found someone')
  } else if (expected === 1) {
    if (nobody >= threshold && one < threshold) failures.push('figures: expected one, found nobody')
    if (several >= threshold) failures.push('figures: expected one, found several')
  } else if (nobody >= threshold && one < threshold && several < threshold) {
    failures.push(`figures: expected ${expected}, found nobody`)
  } else if (at('solo') >= 0.6 && several < threshold) {
    failures.push(`figures: expected ${expected}, found one`)
  }
  if (at('multiple views') >= threshold) failures.push('figures: multiple views (a turnaround, not a scene)')
  for (const name of ['bad anatomy', 'bad hands', 'extra arms', 'extra legs', 'deformed']) {
    if (at(name) >= threshold) failures.push(`anatomy: ${name}`)
  }
  return failures
}
