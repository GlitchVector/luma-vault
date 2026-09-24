#!/usr/bin/env node
/**
 * The LoRA line's own tooling, in the repo rather than in a session's temp folder.
 *
 *     pnpm lora status <name>                       what exists for a training: epochs, log, checks, Forge, trainer
 *     pnpm lora plan   <name> --dataset <toml>      what the run WILL be, against the reference run's budget
 *     pnpm lora train  <name> --dataset <toml> --go the gated launch: refuses a run below the reference budget
 *     pnpm lora diff   [<reference>] <name>         two runs side by side, from their kohya logs
 *     pnpm lora sweep  <name> --trigger <word>      the fixed 32-frame check on saved epochs, then contact sheets
 *
 * The gate (plan / train / diff) exists because the ari_gen line trained five times at 62 % of the
 * reference budget while three of those runs changed captions, and the rule against exactly that sat in
 * the docs unread (2026-09-24). The numbers live in scripts/lora-recipe.json, nowhere else.
 *
 * The sweep is the rule in `.ai/lora-training.md` §3.12: the same 32 frames
 * (eight framings, dressed and undressed, weights 1.0 and 1.2) on BOTH
 * checkpoints, trigger only, for each saved epoch file. It refuses while a
 * kohya trainer is running (a render beside a training hung Forge and killed
 * the trainer once), copies the epoch files into Forge, starts Forge if it is
 * down, queues only the frames that are not on disk yet, drains, and repeats
 * until every frame exists — because the drain has lost queued jobs twice when
 * a stale lock overlapped, and "run it again until nothing is missing" is the
 * only honest fix from outside the queue.
 *
 * Frames land in D:\AI\lora-train\checks\<name>\ beside every other epoch's,
 * and the sheets in checks\<name>\sheets\. The person judges the sheets.
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compareRuns, dirImageCounter, loadRecipe, planRun, readTrainingLog } from './lib/lora-gate.mjs'

const REPO = resolve(import.meta.dirname, '..')
const TRAIN = process.env.LUMA_LORA_TRAIN ?? 'D:\\AI\\lora-train'
const FORGE_DIR = process.env.LUMA_FORGE_DIR ?? 'D:\\AI\\Stable Diffusion'
const LORA_DIR = join(FORGE_DIR, 'webui', 'models', 'Lora')
const FORGE = process.env.LUMA_FORGE_URL ?? 'http://127.0.0.1:7860'
const PYTHON = join(REPO, 'venv-classifier', 'Scripts', 'python.exe')

// The fixed check. Same words as every Ari sweep since 2026-09-16, so the
// numbers stay comparable across lines and versions.
const QUALITY = 'masterpiece, best quality, very aesthetic, absurdres'
const NEGATIVE =
  'worst quality, bad quality, lowres, bad anatomy, bad hands, extra digits, jpeg artifacts, watermark, signature, (english text:1.3), (multiple views:1.4), (2girls:1.5), multiple girls, high contrast, (censored:1.4), light censor'
const SCENE = 'indoors, window, bedroom'
const SHOTS = [
  ['face', '(portrait:1.4), close-up, looking at viewer', ''],
  ['dressed', '(full body:1.3), standing, facing viewer, looking at viewer', ''],
  ['behind', '(full body:1.3), standing, from behind, (looking back:1.2)', ''],
  ['side', '(full body:1.3), standing, from side, profile', ''],
  ['cowboy', '(cowboy shot:1.3), standing, looking at viewer', ''],
  ['topless', '(cowboy shot:1.3), standing, looking at viewer', 'topless, breasts out, nipples'],
  ['topless-b', '(full body:1.3), standing, from behind, (looking back:1.2)', 'topless, breasts out, nipples'],
  ['nude', '(full body:1.3), standing, facing viewer, looking at viewer', 'completely nude, nipples, pussy'],
]

const argv = process.argv.slice(2)
const [command, name] = argv
const flag = (key, fallback) => {
  const at = argv.indexOf(`--${key}`)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}
const has = (key) => argv.includes(`--${key}`)

function fail(...lines) {
  console.error(lines.join('\n'))
  process.exit(1)
}

function usage() {
  fail(
    'usage: pnpm lora status <name>',
    '       pnpm lora plan   <name> --dataset <toml> [--epochs N] [--stage1]',
    '       pnpm lora train  <name> --dataset <toml> [--epochs N] [--stage1] [--under-budget "<reason>"] --go',
    '       pnpm lora diff   [<reference>] <name>     (default reference: the one in scripts/lora-recipe.json)',
    '       pnpm lora sweep  <name> --trigger <word> [--epochs 20,28,final] [--models delburry75,plantmilk]',
    '                        [--weights 1.0,1.2] [--out <dir>] [--passes 3] [--no-sheets] [--dry-run]',
    '',
    '  <name> is the training output name, e.g. ari_gen_v3 (D:\\AI\\lora-train\\output\\<name>\\).',
    '  "final" is the file without an epoch suffix. Frames go to D:\\AI\\lora-train\\checks\\<name>\\.',
  )
}

// --- what is on disk -----------------------------------------------------------

function epochFiles(trainingName) {
  const dir = join(TRAIN, 'output', trainingName)
  if (!existsSync(dir)) return { dir, epochs: [], final: null }
  const files = readdirSync(dir).filter((f) => f.endsWith('.safetensors'))
  const epochs = files
    .map((f) => f.match(new RegExp(`^${trainingName}-(\\d{6})\\.safetensors$`)))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
  const final = files.includes(`${trainingName}.safetensors`) ? `${trainingName}.safetensors` : null
  return { dir, epochs, final }
}

function fileFor(trainingName, epoch) {
  return epoch === 'final' ? trainingName : `${trainingName}-${String(epoch).padStart(6, '0')}`
}

function trainerRunning() {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'sdxl_train_network' } | Measure-Object).Count"],
    { encoding: 'utf8' },
  )
  return Number((r.stdout ?? '0').trim()) > 0
}

async function forgeUp() {
  try {
    const r = await fetch(`${FORGE}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(5000) })
    return r.ok
  } catch {
    return false
  }
}

function lastProgress(trainingName) {
  const err = join(TRAIN, 'output', `${trainingName}.err.log`)
  if (!existsSync(err)) return null
  const text = readFileSync(err, 'utf8').replace(/\r/g, '\n')
  const lines = text.split('\n').filter((l) => l.includes('steps:'))
  return lines.at(-1)?.replace(/[^\x20-\x7e]/g, '').trim() ?? null
}

// --- status -------------------------------------------------------------------------

async function status(trainingName) {
  const { dir, epochs, final } = epochFiles(trainingName)
  console.log(`${trainingName}`)
  console.log(`  output   : ${dir}${existsSync(dir) ? '' : '  (does not exist)'}`)
  console.log(`  epochs   : ${epochs.length ? epochs.join(', ') : 'none'}${final ? ' + final' : ''}`)
  const progress = lastProgress(trainingName)
  if (progress) console.log(`  progress : ${progress}`)
  console.log(`  trainer  : ${trainerRunning() ? 'RUNNING — no rendering until it is done' : 'not running'}`)
  console.log(`  forge    : ${(await forgeUp()) ? 'up' : 'down'}`)
  const installed = [...epochs.map((e) => fileFor(trainingName, e)), final ? trainingName : null]
    .filter(Boolean)
    .filter((stem) => existsSync(join(LORA_DIR, `${stem}.safetensors`)))
  console.log(`  in forge : ${installed.length ? installed.join(', ') : 'none'}`)
  const checks = join(TRAIN, 'checks', trainingName)
  if (existsSync(checks)) {
    const counts = {}
    for (const f of readdirSync(checks).filter((f) => f.endsWith('.png'))) {
      const prefix = f.split('-')[0]
      counts[prefix] = (counts[prefix] ?? 0) + 1
    }
    console.log(`  checks   : ${Object.entries(counts).map(([p, n]) => `${p} ${n}/32`).join(', ') || 'none'}`)
    const sheets = join(checks, 'sheets')
    if (existsSync(sheets)) for (const f of readdirSync(sheets)) console.log(`             ${join(sheets, f)}`)
  } else {
    console.log('  checks   : none')
  }
}

// --- sweep ------------------------------------------------------------------------

function shortName(trainingName) {
  // ari_gen_v3 -> agv3, ari_adopt_v7 -> av7: initials of the line plus the version.
  const parts = trainingName.split('_')
  const version = parts.at(-1)
  return parts.slice(0, -1).map((p) => p[0]).join('') + version
}

function queueMissing({ lora, trigger, prefix, out, models, weights, stamp, dryRun }) {
  let queued = 0
  let present = 0
  for (const model of models) {
    for (const weight of weights) {
      for (const [label, framing, state] of SHOTS) {
        const file = join(out, `${prefix}-${model}-w${weight}-${label}.png`)
        if (existsSync(file)) {
          present++
          continue
        }
        const prompt = [
          `${QUALITY}, ${framing}`,
          `<lora:${lora}:${weight}>, ${trigger}, 1girl, solo${state ? `, uncensored, ${state}` : ''}`,
          SCENE,
        ].join('\nBREAK\n')
        const args = [
          '--env-file-if-exists=.env',
          '--experimental-strip-types',
          'scripts/open-in-forge.mjs',
          '--model', model,
          '--queue', '--no-adetailer', '--keep-facing',
          '--label', `${prefix}-${model}-w${weight}-${label}`,
          '--render', file,
          '--set', `lora/${lora.replace(/_/g, '-')}-check/${stamp}`,
          '--shot-label', `${lora} ${model} @${weight} ${label} (trigger only)`,
          '--prompt', prompt,
          '--negative', NEGATIVE,
        ]
        if (dryRun) {
          console.log(`  would queue ${label} on ${model} @${weight}`)
          queued++
          continue
        }
        const r = spawnSync('node', args, { cwd: REPO, encoding: 'utf8' })
        if (!/queued/.test(r.stdout)) fail(`could not queue ${label} on ${model} @${weight}:\n${r.stdout}\n${r.stderr}`)
        queued++
      }
    }
  }
  return { queued, present }
}

function drain() {
  return new Promise((done) => {
    const child = spawn('node', ['--env-file-if-exists=.env', '--experimental-strip-types', 'scripts/render-queue.mjs', '--drain'], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let rendered = 0
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      for (const line of chunk.split('\n')) {
        if (/… ok/.test(line)) rendered++
        if (/rendered|failed|Another drain|stale/.test(line)) console.log(`  ${line.trim()}`)
      }
    })
    child.on('close', () => done(rendered))
  })
}

async function ensureForge() {
  if (await forgeUp()) return
  console.log('starting Forge…')
  spawn('cmd.exe', ['/c', 'start', '""', '/min', join(FORGE_DIR, 'START_FORGE.bat')], { cwd: FORGE_DIR, detached: true, stdio: 'ignore' }).unref()
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    if (await forgeUp()) {
      await new Promise((r) => setTimeout(r, 10_000))
      return
    }
  }
  fail('Forge did not answer within 10 minutes')
}

function sheets(out, prefix, models) {
  const dir = join(out, 'sheets')
  mkdirSync(dir, { recursive: true })
  const made = []
  for (const model of models) {
    const target = join(dir, `${prefix}-${model}.png`)
    const r = spawnSync(PYTHON, [join(REPO, 'scripts', 'lora-sheets.py'), out, `${prefix}-${model}`, target], { encoding: 'utf8' })
    if (r.status !== 0) console.error(`  sheet failed for ${prefix}-${model}: ${r.stderr.trim().slice(-300)}`)
    else made.push(target)
  }
  return made
}

async function sweep(trainingName) {
  const trigger = flag('trigger')
  if (!trigger) fail('--trigger <word> is required: the check renders the trigger alone')
  const epochs = flag('epochs', '20,28,final').split(',').map((e) => e.trim())
  const models = flag('models', 'delburry75,plantmilk').split(',')
  const weights = flag('weights', '1.0,1.2').split(',')
  const passes = Number(flag('passes', '3'))
  const out = flag('out', join(TRAIN, 'checks', trainingName))
  const dryRun = has('dry-run')

  if (trainerRunning()) fail('a kohya trainer is running: never render while training (it hung Forge and killed the trainer on 2026-09-16)')
  const have = epochFiles(trainingName)
  for (const epoch of epochs) {
    const stem = fileFor(trainingName, epoch)
    if (!existsSync(join(have.dir, `${stem}.safetensors`))) fail(`no ${stem}.safetensors in ${have.dir} (saved epochs: ${have.epochs.join(', ') || 'none'}${have.final ? ', final' : ''})`)
  }
  mkdirSync(out, { recursive: true })
  const short = shortName(trainingName)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', 'T')
  console.log(`${trainingName}: epochs ${epochs.join(', ')} × ${models.join('/')} × ${weights.join('/')} = ${epochs.length * models.length * weights.length * SHOTS.length} frames → ${out}`)
  if (!dryRun) await ensureForge()

  const allSheets = []
  for (const epoch of epochs) {
    const stem = fileFor(trainingName, epoch)
    const prefix = `${short}e${epoch === 'final' ? have.epochs.at(-1) + 2 || 'final' : epoch}`
    const target = join(LORA_DIR, `${stem}.safetensors`)
    if (!existsSync(target) && !dryRun) {
      copyFileSync(join(have.dir, `${stem}.safetensors`), target)
      console.log(`copied ${stem}.safetensors into Forge`)
    }
    for (let pass = 1; pass <= passes; pass++) {
      const { queued, present } = queueMissing({ lora: stem, trigger, prefix, out, models, weights, stamp, dryRun })
      console.log(`epoch ${epoch} (${prefix}) pass ${pass}: ${present} present, ${queued} queued`)
      if (queued === 0 || dryRun) break
      const rendered = await drain()
      console.log(`  drained ${rendered}`)
    }
    const { queued: missing } = queueMissing({ lora: stem, trigger, prefix, out, models, weights, stamp, dryRun: true })
    if (missing > 0 && !dryRun) console.error(`  ${missing} frame(s) still missing after ${passes} passes — run the sweep again`)
    if (!has('no-sheets') && !dryRun) allSheets.push(...sheets(out, prefix, models))
  }
  if (allSheets.length) {
    console.log('sheets:')
    for (const s of allSheets) console.log(`  ${s}`)
  }
  console.log('the person judges the sheets; the epoch files stay in Forge until the verdict moves one to final/ and the rest to wip/')
}


// --- the gate -----------------------------------------------------------------------

const RECIPE_FILE = join(REPO, 'scripts', 'lora-recipe.json')

function printPlan(trainingName, plan, recipe, stage1) {
  console.log(`${trainingName}${stage1 ? ' (stage 1)' : ''} against ${recipe.reference.name} (${recipe.reference.epochs} epochs, ${recipe.reference.steps} steps)`)
  for (const r of plan.rows)
    console.log(`  ${String(r.images).padStart(4)} x ${String(r.repeats).padEnd(3)} = ${String(r.seen).padStart(5)}  ${r.dir}${r.undressed ? '  (undressed)' : ''}`)
  console.log(`  per epoch     : ${plan.perEpoch} images -> ${plan.stepsPerEpoch} steps at batch ${plan.batch}`)
  console.log(`  undressed     : ${(plan.undressedShare * 100).toFixed(1)} % (allowed ${plan.rules.undressedShare.map((x) => x * 100).join('-')} %)`)
  if (!stage1) console.log(`  needed        : ${plan.neededEpochs} epochs to reach ${plan.rules.minSteps} steps (never below ${plan.rules.minEpochs})`)
  console.log(`  this run      : ${plan.epochs} epochs = ${plan.steps} steps${stage1 ? '' : ` = ${Math.round((plan.steps / plan.rules.minSteps) * 100)} % of the reference`}`)
  console.log(`  rank / alpha  : ${plan.rules.dim} / ${plan.rules.alpha}, TE lr ${plan.rules.teLr}`)
  console.log(plan.problems.length ? `  REFUSED       : ${plan.problems.join('; ')}` : '  OK            : within the recipe')
}

function makePlan() {
  const dataset = flag('dataset')
  if (!dataset || !existsSync(dataset)) fail('--dataset <path to the dataset toml> is required and must exist')
  const recipe = loadRecipe(RECIPE_FILE)
  const stage1 = has('stage1')
  const epochs = flag('epochs') ? Number(flag('epochs')) : undefined
  const plan = planRun({ toml: readFileSync(dataset, 'utf8'), countImages: dirImageCounter, recipe, epochs, stage1 })
  return { dataset, recipe, stage1, plan }
}

function planCommand(trainingName) {
  const { recipe, stage1, plan } = makePlan()
  printPlan(trainingName, plan, recipe, stage1)
  if (plan.problems.length) process.exit(1)
}

async function trainCommand(trainingName) {
  const { dataset, recipe, stage1, plan } = makePlan()
  printPlan(trainingName, plan, recipe, stage1)
  const reason = flag('under-budget')
  if (plan.problems.length && !reason)
    fail('', "Not starting. Fix the dataset or the epochs, or - only with the owner's explicit agreement - pass", '--under-budget "<reason>"; the reason is written beside the run and belongs in its register row.')
  if (existsSync(join(TRAIN, 'output', trainingName, `${trainingName}.safetensors`))) fail(`output/${trainingName} already has a final file - pick a new name`)
  if (trainerRunning()) fail('a kohya trainer is already running')
  if (await forgeUp()) fail('Forge is up: never render while training (2026-09-16). Stop Forge first, then run this again.')
  if (!has('go')) fail('', "Plan only. A training starts on the owner's explicit go - rerun with --go once he has given it.")
  const rules = plan.rules
  const note = {
    name: trainingName, dataset, startedAt: new Date().toISOString(), stage1, epochs: plan.epochs, steps: plan.steps,
    stepsPerEpoch: plan.stepsPerEpoch, undressedShare: plan.undressedShare, reference: recipe.reference.name,
    referenceSteps: recipe.reference.steps, underBudget: reason ?? null, problems: plan.problems,
  }
  mkdirSync(join(TRAIN, 'output'), { recursive: true })
  writeFileSync(join(TRAIN, 'output', `${trainingName}.gate.json`), JSON.stringify(note, null, 2))
  const args = ['-NoProfile', '-File', join(TRAIN, 'train-oracle.ps1'), '-Name', trainingName, '-Epochs', String(plan.epochs), '-Dim', String(rules.dim), '-Alpha', String(rules.alpha), '-TeLr', rules.teLr, '-Dataset', dataset]
  if (stage1) args.push('-Stage1')
  if (reason) args.push('-UnderBudget', reason)
  const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')
  const log = join(TRAIN, 'output', `${trainingName}.log`)
  const err = join(TRAIN, 'output', `${trainingName}.err.log`)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell -WindowStyle Hidden -ArgumentList ${quoted} -RedirectStandardOutput '${log}' -RedirectStandardError '${err}'`], { encoding: 'utf8' })
  if (r.status !== 0) fail(`could not start the trainer: ${r.stderr}`)
  console.log(`started ${trainingName}: ${plan.epochs} epochs, ${plan.steps} steps; logs ${log} and ${err}`)
}

function diffCommand(first, second) {
  const recipe = loadRecipe(RECIPE_FILE)
  const [refName, name] = second ? [first, second] : [recipe.reference.name, first]
  const ref = readTrainingLog(TRAIN, refName)
  const run = readTrainingLog(TRAIN, name)
  if (!ref) fail(`no log for ${refName} in ${join(TRAIN, 'output')}`)
  if (!run) fail(`no log for ${name} in ${join(TRAIN, 'output')}`)
  console.log(compareRuns(refName, ref, name, run))
}

if (!command || !name || has('help')) usage()
if (command === 'status') await status(name)
else if (command === 'sweep') await sweep(name)
else if (command === 'plan') planCommand(name)
else if (command === 'train') await trainCommand(name)
else if (command === 'diff') diffCommand(name, argv[2] && !argv[2].startsWith('--') ? argv[2] : undefined)
else usage()
