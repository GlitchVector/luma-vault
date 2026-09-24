/**
 * The training gate: what a run WILL be (from its dataset toml) and what a run WAS (from its kohya log),
 * both measured against the reference run in scripts/lora-recipe.json.
 *
 * It exists because the ari_gen line trained five times at 62 % of the budget that made the reference
 * LoRA work, while three of those trainings changed captions instead: the rule was in the docs, and
 * nothing checked it (2026-09-24). Pure functions over text and a directory lister, so the numbers can
 * be tested without a GPU.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const IMAGE = /\.(png|jpe?g|webp)$/i

export function loadRecipe(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** The subsets of a kohya dataset toml: image_dir, num_repeats, and the dataset's batch_size. */
export function parseDatasetToml(text) {
  let batch = 1
  const subsets = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    if (/^\[\[datasets\.subsets\]\]$/.test(line)) {
      current = { dir: null, repeats: 1 }
      subsets.push(current)
      continue
    }
    const kv = line.match(/^([a-z_]+)\s*=\s*(.+)$/)
    if (!kv) continue
    const [, key, value] = kv
    const unquoted = value.replace(/^"(.*)"$/, '$1')
    if (key === 'batch_size') batch = Number(unquoted)
    else if (current && key === 'image_dir') current.dir = unquoted
    else if (current && key === 'num_repeats') current.repeats = Number(unquoted)
  }
  return { batch, subsets }
}

/** A subset whose folder name says it holds undressed frames - the share the recipe bounds. */
export const isUndressed = (dir) => /undress/i.test(dir ?? '')

/**
 * The plan for a run: images x repeats per subset, steps per epoch at the dataset's batch size, the
 * epochs needed to reach the reference budget, and whether the requested epochs clear it.
 */
export function planRun({ toml, countImages, recipe, epochs, stage1 = false }) {
  const { batch, subsets } = parseDatasetToml(toml)
  const rows = subsets.map((s) => {
    const images = countImages(s.dir)
    return { dir: s.dir, images, repeats: s.repeats, seen: images * s.repeats, undressed: isUndressed(s.dir) }
  })
  const perEpoch = rows.reduce((n, r) => n + r.seen, 0)
  const stepsPerEpoch = Math.ceil(perEpoch / batch)
  const undressedShare = perEpoch ? rows.filter((r) => r.undressed).reduce((n, r) => n + r.seen, 0) / perEpoch : 0
  const rules = stage1 ? recipe.stage1 : recipe.final
  const minSteps = stage1 ? 0 : rules.minSteps
  const neededEpochs = stage1 ? rules.epochs : Math.max(rules.minEpochs, Math.ceil(minSteps / Math.max(stepsPerEpoch, 1)))
  const chosenEpochs = epochs ?? neededEpochs
  const steps = chosenEpochs * stepsPerEpoch
  const problems = []
  if (rows.some((r) => r.images === 0)) problems.push(`empty subset(s): ${rows.filter((r) => r.images === 0).map((r) => r.dir).join(', ')}`)
  if (!stage1 && chosenEpochs < rules.minEpochs) problems.push(`${chosenEpochs} epochs is below the minimum ${rules.minEpochs}`)
  if (!stage1 && steps < minSteps) problems.push(`${steps} steps is ${Math.round((steps / minSteps) * 100)} % of the reference ${recipe.reference.name}'s ${minSteps}`)
  const [lo, hi] = rules.undressedShare
  if (undressedShare < lo - 1e-9 || undressedShare > hi + 1e-9)
    problems.push(`undressed share ${(undressedShare * 100).toFixed(1)} % is outside ${lo * 100}-${hi * 100} %`)
  return { batch, rows, perEpoch, stepsPerEpoch, undressedShare, neededEpochs, epochs: chosenEpochs, steps, rules, problems }
}

export function dirImageCounter(dir) {
  if (!dir || !existsSync(dir)) return 0
  return readdirSync(dir).filter((f) => IMAGE.test(f)).length
}

/** What a finished (or running) kohya run actually did, read from its logs. */
export function parseTrainingLog(text) {
  const lines = text.replace(/\r/g, '\n').split('\n')
  const subsets = []
  for (let i = 0; i < lines.length; i++) {
    if (!/image_dir:/.test(lines[i])) continue
    let dir = ''
    let j = i + 1
    for (; j < lines.length && !/image_count:/.test(lines[j]); j++) dir += lines[j].trim()
    const count = Number(lines[j]?.match(/image_count:\s*(\d+)/)?.[1] ?? NaN)
    let repeats = NaN
    for (let k = j; k < Math.min(lines.length, j + 12); k++) {
      const m = lines[k].match(/num_repeats:\s*(\d+)/)
      if (m) {
        repeats = Number(m[1])
        break
      }
    }
    subsets.push({ dir: dir.replace(/"/g, '').replace(/\s+/g, ''), images: count, repeats, seen: count * repeats, undressed: isUndressed(dir) })
    i = j
  }
  const num = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  const perEpoch = num(/num train images \* repeats[^:]*:\s*(\d+)/)
  const epochs = num(/num epochs[^:]*:\s*(\d+)/)
  const steps = num(/total optimization steps[^:]*:\s*(\d+)/)
  const stepsPerEpoch = num(/num batches per epoch[^:]*:\s*(\d+)/)
  const batch = num(/batch_size:\s*(\d+)/)
  const seen = subsets.reduce((n, s) => n + (s.seen || 0), 0)
  const undressedShare = seen ? subsets.filter((s) => s.undressed).reduce((n, s) => n + s.seen, 0) / seen : null
  return { subsets, perEpoch, epochs, steps, stepsPerEpoch, batch, undressedShare }
}

export function readTrainingLog(trainDir, name) {
  const parts = [`${name}.log`, `${name}.err.log`].map((f) => join(trainDir, 'output', f)).filter(existsSync)
  if (!parts.length) return null
  return parseTrainingLog(parts.map((p) => readFileSync(p, 'utf8')).join('\n'))
}

const pct = (a, b) => (a != null && b ? `${Math.round((a / b) * 100)} %` : '-')
const share = (x) => (x == null ? '-' : `${(x * 100).toFixed(1)} %`)

/** Two runs side by side, the second measured against the first (the reference). */
export function compareRuns(refName, ref, name, run) {
  const rows = [
    ['epochs', ref.epochs, run.epochs],
    ['images x repeats / epoch', ref.perEpoch, run.perEpoch],
    ['steps / epoch', ref.stepsPerEpoch, run.stepsPerEpoch],
    ['total steps', ref.steps, run.steps],
    ['undressed share', share(ref.undressedShare), share(run.undressedShare)],
  ]
  const width = Math.max(refName.length, 10)
  const out = [`${''.padEnd(26)}${refName.padEnd(width + 2)}${name}`]
  for (const [label, a, b] of rows) out.push(`${label.padEnd(26)}${String(a ?? '-').padEnd(width + 2)}${b ?? '-'}`)
  out.push(`${'budget vs reference'.padEnd(26)}${''.padEnd(width + 2)}${pct(run.steps, ref.steps)}`)
  out.push('', 'subsets (images x repeats):')
  const list = (label, subs) => {
    out.push(`  ${label}`)
    for (const s of subs) out.push(`    ${String(s.images).padStart(4)} x ${String(s.repeats).padEnd(3)} = ${String(s.seen).padStart(5)}  ${s.dir}${s.undressed ? '  (undressed)' : ''}`)
  }
  list(refName, ref.subsets)
  list(name, run.subsets)
  return out.join('\n')
}
