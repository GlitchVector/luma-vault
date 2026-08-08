#!/usr/bin/env node
/**
 * Open Forge with a freshly written prompt, on a chosen checkpoint.
 *
 *     pnpm open-in-forge --prompt "1girl, ..." --negative "lowres, ..."
 *     pnpm open-in-forge --prompt "..." --model illustrious --width 1216 --height 832
 *
 * The `/recreate` skill's exit: it composes a prompt from an attached image and
 * hands it here, and this does the Forge choreography that migrate-prompt.mjs
 * already does for indexed images — resolve the newest matching checkpoint,
 * select it *before* the tab opens (Forge reads the dropdown's value once,
 * while building the page), then open a tab whose fragment the prefill
 * extension unpacks.
 *
 * Settings are the booru-XL tuning the migration uses (CFG 5, 28 steps, clip
 * skip 2), because the skill targets modern checkpoints. `--dry-run` resolves
 * the model and prints the block but touches nothing — no selection, no tab.
 */

import { enforceFraming, enforceUndress } from '../packages/core/src/migrate.ts'
import {
  DEFAULT_MODEL,
  PORTRAIT,
  PORTRAIT_WIDTH,
  PORTRAIT_HEIGHT,
  familyOf,
  settingsFor,
  warnAboutVPrediction,
  inspectCheckpoint,
  fail,
  openWithBlock,
  renderWithBlock,
  resolveModel,
  selectCheckpoint,
  unescapeNewlines,
} from './lib/forge.mjs'

const unescape = unescapeNewlines

function parseArgs(argv) {
  // Portrait regardless of the attached image's shape — see PORTRAIT. The
  // caller is not meant to derive a canvas from what it was handed.
  const args = {
    model: DEFAULT_MODEL,
    width: PORTRAIT_WIDTH,
    height: PORTRAIT_HEIGHT,
    cfg: 5,
    dryRun: false,
  }
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at]
    if (flag === '--dry-run') args.dryRun = true
    else if (flag === '--prompt') args.prompt = unescape(argv[++at])
    else if (flag === '--negative') args.negative = unescape(argv[++at])
    else if (flag === '--adetailer-prompt') args.adPrompt = unescape(argv[++at])
    else if (flag === '--adetailer-negative') args.adNegative = unescape(argv[++at])
    else if (flag === '--model') args.model = argv[++at]
    else if (flag === '--width') args.width = Number(argv[++at])
    else if (flag === '--height') args.height = Number(argv[++at])
    // Booru-XL sits at 5, but NoobAI wants 4-6 and burns colour at the top of
    // that — a saturated, night-lit render from a daylight prompt is the tell.
    else if (flag === '--cfg') { args.cfg = Number(argv[++at]); args.cfgGiven = true }
    // How the picture is rendered. See STYLES in @luma/core — the tags are
    // checked against the tagger's vocabulary, unlike the obvious words for
    // this, most of which are not tags at all.
    else if (flag === '--style') args.style = String(argv[++at]).toLowerCase()
    // Generate rather than open a tab, writing the picture here. What the
    // -multi commands use past two shots — see `renderWithBlock`.
    else if (flag === '--render') args.render = argv[++at]
    else fail(`unknown argument: ${flag}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.prompt) {
  fail(
    'usage: pnpm open-in-forge --prompt "..." [--negative "..."] [--model substring] [--width N --height N]',
    '',
    '  --model defaults to ' + DEFAULT_MODEL + `; the canvas is ${PORTRAIT} unless overridden,`,
    '  whatever shape the source image was — it is not read off the attachment.',
    '  --dry-run prints the parameter block without touching Forge.',
  )
}
if (!Number.isFinite(args.width) || !Number.isFinite(args.height)) {
  fail('--width and --height must be numbers')
}

// Claims the framing has turned away from. Enforced here rather than left to
// whoever composed the prompt: `from behind` beside `cleavage, huge nipples,
// topless` does not produce a back view missing those details, it produces a
// front view — the framing is outvoted, silently, and a row of tabs meant to be
// different angles comes back as one angle repeated. See FACING_CONFLICTS.
const framed = enforceFraming(args.prompt)
args.prompt = framed.text

// Garments the prompt's own state of undress rules out. `/swap` is where this
// earns its keep — a new character arrives with her reference outfit while the
// original still says `bottomless` — but the contradiction is worth catching
// wherever it came from, including a garment typed into the last-look edit.
const dressed = enforceUndress(args.prompt)
args.prompt = dressed.text

const target = await resolveModel(args.model)
const { architecture, vPred } = inspectCheckpoint(target.filename)
if (architecture !== 'xl') {
  // Not fatal — the block still opens — but the canvas and tuning here are
  // SDXL's, and generating an SD1.5 image at 832x1216 gives doubled anatomy,
  // which would read as the prompt being bad rather than the canvas.
  console.error(
    `note: ${target.name} is ${architecture}, and these settings assume xl — expect the canvas to be wrong for it.`,
  )
}

// The same shape Forge writes into its own PNGs, which is what its paste
// parser (and the prefill extension behind it) understands best. Hires and
// ADetailer are always in the block: the extension turns their toggles on for
// exactly the fields named here, and a keeper gets both passes anyway. The
// ADetailer prompt arrives from the skill, which saw the image and knows which
// tags are identity — quoted, because it contains commas and the settings line
// is comma-separated.
const quote = (value) => '"' + String(value).replaceAll('"', "'") + '"'
// A v-prediction checkpoint predicts v rather than noise. The sampler is the
// half a parameter block can carry — the *mode* is the webui's job, and not
// every build does it. See the warning below.
// What this family was actually generated at, where it differs from the
// booru-XL default — see `settingsFor`. A v-prediction target overrides the
// sampler regardless, because that is a correctness question rather than a
// taste one.
const tuned = settingsFor(familyOf(target.name), architecture)
const sampler = vPred
  ? ['Sampler: Euler']
  : tuned
    ? [`Sampler: ${tuned.sampler}`, `Schedule type: ${tuned.schedule}`]
    : ['Sampler: DPM++ 2M SDE', 'Schedule type: Karras']
if (vPred) warnAboutVPrediction(target.name)
if (tuned) {
  console.error(
    `note: using ${target.name}'s own tuning — CFG ${tuned.cfg}, ${tuned.steps} steps,
` +
      `  ${tuned.sampler} ${tuned.schedule} — what this checkpoint's own card asks for,
` +
      '  rather than the booru-XL default. Override with --cfg.',
  )
}
const settings = [
  `Steps: ${tuned ? tuned.steps : 28}`,
  ...sampler,
  `CFG scale: ${args.cfgGiven ? args.cfg : (tuned ? tuned.cfg : args.cfg)}`,
  'Seed: -1',
  `Size: ${args.width}x${args.height}`,
  `Model: ${target.name}`,
  'Clip skip: 2',
  'Denoising strength: 0.4',
  'Hires upscale: 1.5',
  'Hires steps: 30',
  'Hires upscaler: 4xUltrasharp_4xUltrasharpV10',
  'ADetailer model: face_yolov8s.pt',
  args.adPrompt ? `ADetailer prompt: ${quote(args.adPrompt)}` : null,
  `ADetailer negative prompt: ${quote(args.adNegative ?? args.negative ?? 'worst quality, low quality, lowres')}`,
  'ADetailer denoising strength: 0.4',
].filter(Boolean).join(', ')

// The family's activation token, at the end where its card puts it — the
// trained style is simply not engaged without it.
const STYLES = {
  '2d': { positive: 'anime coloring, flat color', negative: 'realistic, photorealistic, shiny skin' },
  '2.5d': { positive: 'realistic, shiny skin', negative: 'flat color, anime coloring, photorealistic' },
  '3d': {
    positive: 'photorealistic, realistic, shiny skin',
    negative: 'anime coloring, flat color, lineart, sketch',
  },
}
if (args.style && !STYLES[args.style]) {
  fail(`--style takes 2d, 2.5d or 3d (got "${args.style}")`)
}
const style = args.style ? STYLES[args.style] : null
const styled = style ? `${style.positive},
${args.prompt}` : args.prompt
if (style) args.negative = [args.negative, style.negative].filter(Boolean).join(', ')

const prompt =
  tuned?.trigger && !styled.toLowerCase().includes(tuned.trigger)
    ? `${styled.replace(/,\s*$/, '')}, ${tuned.trigger}`
    : styled

const block = [prompt, args.negative ? `Negative prompt: ${args.negative}` : null, settings]
  .filter(Boolean)
  .join('\n')

console.log(`model  ${target.name}  (${architecture})`)
if (framed.removed.length > 0) {
  console.log(
    `dropped ${[...new Set(framed.removed)].join(', ')} — the framing faces away from them`,
  )
}
if (framed.weighted.length > 0) {
  console.log(`weighted the framing — bare, it loses to the body tags`)
}
if (dressed.removed.length > 0) {
  console.log(
    `dropped ${[...new Set(dressed.removed)].join(', ')} — the prompt says that much is not worn`,
  )
}
console.log('')
console.log(block)

if (args.dryRun) {
  console.log('\ndry run: nothing selected, nothing opened.')
  process.exit(0)
}

const renderTo = args.render
if (renderTo) {
  // Generated here rather than in a tab. Above two tabs the browser is the
  // bottleneck, not the model: a Forge page's load handler runs on Gradio's
  // queue and they wedge behind each other. See `renderWithBlock`.
  console.log(`
rendering… (this is the model's own time, not a stagger)`)
  try {
    const { path, seed } = await renderWithBlock(block, renderTo)
    console.log(`rendered  ${path}${seed === undefined ? '' : `  seed ${seed}`}`)
    console.log('Forge saved its own copy to its outputs folder, so the library will index it.')
  } catch (error) {
    fail(`
Forge refused the render: ${error.message}`, 'Nothing was opened and nothing was saved.')
  }
  process.exit(0)
}

const selected = await selectCheckpoint(target.name)
openWithBlock(block)
console.log(
  selected
    ? '\nopened Forge with the prompt prefilled.'
    : '\nopened Forge with the prompt prefilled. The dropdown still shows the running batch’s ' +
        `model; generating from this tab switches to ${target.name}.`,
)
