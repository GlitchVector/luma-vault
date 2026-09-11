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

import { basename, extname } from 'node:path'
import { enforceFraming, enforceUndress } from '../packages/core/src/migrate.ts'
import {
  DEFAULT_MODEL,
  PORTRAIT,
  PORTRAIT_WIDTH,
  PORTRAIT_HEIGHT,
  familyOf,
  settingsFor,
  warnAboutVPrediction,
  describeCheckpoint,
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
    else if (flag === '--no-adetailer') args.noAdetailer = true
    else if (flag === '--no-hires') args.noHires = true
    // The hires pass and the face pass each have one denoise and the hires pass one upscaler; the defaults
    // (0.4 / 0.4 / 4xUltraSharp) are the booru tuning, overridable for a face that a repaint keeps smoothing.
    else if (flag === '--hires-denoise') args.hiresDenoise = Number(argv[++at])
    else if (flag === '--hires-upscaler') args.hiresUpscaler = argv[++at]
    else if (flag === '--adetailer-denoise') args.adDenoise = Number(argv[++at])
    else if (flag === '--adetailer-prompt') args.adPrompt = unescape(argv[++at])
    else if (flag === '--adetailer-negative') args.adNegative = unescape(argv[++at])
    // Run the face pass on a different checkpoint than the base render — a
    // substring, resolved like --model. The extension's per-unit override.
    else if (flag === '--adetailer-checkpoint') args.adCheckpoint = argv[++at]
    // A second ADetailer unit — a detector of its own, its own prompt and denoise.
    // Written under the extension's ` 2nd` infotext suffix so the block round-trips.
    else if (flag === '--adetailer2-model') args.ad2Model = argv[++at]
    else if (flag === '--adetailer2-prompt') args.ad2Prompt = unescape(argv[++at])
    else if (flag === '--adetailer2-negative') args.ad2Negative = unescape(argv[++at])
    else if (flag === '--adetailer2-denoise') args.ad2Denoise = Number(argv[++at])
    else if (flag === '--adetailer2-dilate') args.ad2Dilate = Number(argv[++at])
    else if (flag === '--adetailer2-padding') args.ad2Padding = Number(argv[++at])
    // Hand the last part of the sampling to another checkpoint. The base model
    // decides the composition in the early steps (which garment, where its seams
    // fall), the refiner paints the finish — the split that lets a model that
    // draws a garment right lend it to a model that renders skin better.
    else if (flag === '--refiner') args.refiner = argv[++at]
    else if (flag === '--refiner-switch') args.refinerSwitch = Number(argv[++at])
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
    // Write the job down instead of generating it, for `pnpm queue --drain` to
    // pick up later. Composes with --render, which then names where the picture
    // will eventually land rather than where it is being written now.
    else if (flag === '--queue') args.queue = true
    // Which command run this render belongs to, so the vault can show the set
    // again afterwards. `<command>/<character>/<stamp>`; see `lib/sets.mjs`.
    else if (flag === '--set') args.set = argv[++at]
    else if (flag === '--shot-label') args.shotLabel = argv[++at]
    else if (flag === '--label') args.label = argv[++at]
    else fail(`unknown argument: ${flag}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const { parseSet } = await import('./lib/sets.mjs')
let set = null
try {
  set = parseSet(args.set)
  if (set) set.label = args.shotLabel ?? null
} catch (error) {
  fail(error.message)
}
if (!args.prompt) {
  fail(
    'usage: pnpm open-in-forge --prompt "..." [--negative "..."] [--model substring] [--width N --height N]',
    '',
    '  --model defaults to ' + DEFAULT_MODEL + `; the canvas is ${PORTRAIT} unless overridden,`,
    '  whatever shape the source image was — it is not read off the attachment.',
    '  --dry-run prints the parameter block without touching Forge.',
    '  --refiner <substring> [--refiner-switch 0.5] hands the sampling to a second checkpoint',
    '  part-way: the base model composes, the refiner paints the finish.',
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
// The face pass's own checkpoint, when asked for. Resolved the same way, so a
// typo fails here with the installed list rather than as a silent no-op in Forge.
const adTarget = args.adCheckpoint && !args.noAdetailer ? await resolveModel(args.adCheckpoint) : null
const refinerTarget = args.refiner ? await resolveModel(args.refiner) : null
const { architecture, vPred } = describeCheckpoint(target)
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
  // --no-hires omits the whole pass, the same way --no-adetailer does. The
  // upscaler invents ring-shaped specular highlights on large, smooth,
  // low-detail areas - it has nothing to sharpen there, so it hallucinates.
  args.noHires ? null : `Denoising strength: ${args.hiresDenoise ?? 0.4}`,
  args.noHires ? null : 'Hires upscale: 1.5',
  args.noHires ? null : 'Hires steps: 30',
  args.noHires ? null : `Hires upscaler: ${args.hiresUpscaler ?? '4xUltrasharp_4xUltrasharpV10'}`,
  // --no-adetailer omits the whole block, which is how the prefill extension
  // knows to leave the toggle off. The pass repaints EVERY face it detects with
  // the same prompt, so on a two-person frame where the man's head is in shot it
  // paints her identity onto him. Cheaper to skip the pass than to fight it.
  args.noAdetailer ? null : 'ADetailer model: face_yolov8s.pt',
  args.noAdetailer || !args.adPrompt ? null : `ADetailer prompt: ${quote(args.adPrompt)}`,
  args.noAdetailer ? null : `ADetailer negative prompt: ${quote(args.adNegative ?? args.negative ?? 'worst quality, low quality, lowres')}`,
  args.noAdetailer ? null : `ADetailer denoising strength: ${args.adDenoise ?? 0.4}`,
  args.noAdetailer || !adTarget ? null : `ADetailer checkpoint: ${adTarget.name}`,
  args.noAdetailer || !args.ad2Model ? null : `ADetailer model 2nd: ${args.ad2Model}`,
  args.noAdetailer || !args.ad2Model || !args.ad2Prompt ? null : `ADetailer prompt 2nd: ${quote(args.ad2Prompt)}`,
  args.noAdetailer || !args.ad2Model ? null : `ADetailer negative prompt 2nd: ${quote(args.ad2Negative ?? args.negative ?? 'worst quality, low quality, lowres')}`,
  args.noAdetailer || !args.ad2Model ? null : `ADetailer denoising strength 2nd: ${args.ad2Denoise ?? 0.5}`,
  args.noAdetailer || !args.ad2Model || args.ad2Dilate == null ? null : `ADetailer dilate erode 2nd: ${args.ad2Dilate}`,
  args.noAdetailer || !args.ad2Model || args.ad2Padding == null ? null : `ADetailer inpaint padding 2nd: ${args.ad2Padding}`,
  // A1111's own infotext keys, so a pasted block round-trips through the UI too.
  refinerTarget ? `Refiner: ${refinerTarget.name}` : null,
  refinerTarget ? `Refiner switch at: ${args.refinerSwitch ?? 0.6}` : null,
].filter(Boolean).join(', ')

// The family's activation token, at the end where its card puts it — the
// trained style is simply not engaged without it.
// `shiny skin` used to sit in the 2.5d and 3d positives, and it is what draws
// the ring-shaped specular blobs on large smooth skin — six or more per frame on
// a body-tuned render. It also silently defeats negating it: with the tag in the
// positive, adding it to the negative just makes the prompt argue with itself.
// So the gloss family moves to the negative for every style, and the soft-light
// terms come with it. `realistic` alone still separates 2.5d from flat 2d.
const GLOSS =
  'shiny skin, oiled body, wet, sweat, glossy, specular highlights, reflection, ' +
  'light particles, sparkle, bloom, lens flare, sunbeam'
const STYLES = {
  '2d': { positive: 'anime coloring, flat color', negative: `realistic, photorealistic, ${GLOSS}` },
  '2.5d': { positive: 'realistic', negative: `flat color, anime coloring, photorealistic, ${GLOSS}` },
  '3d': {
    positive: 'photorealistic, realistic',
    negative: `anime coloring, flat color, lineart, sketch, ${GLOSS}`,
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

// Queued before the render branch, because queueing is the same decision made
// about a later time: everything above has already happened, so the block being
// written down is the one that would have been sent.
if (args.queue) {
  const { enqueue } = await import('./lib/queue.mjs')
  const label = args.label ?? (args.render ? basename(args.render, extname(args.render)) : 'job')
  const job = enqueue({ label, block, destination: args.render, set })
  console.log(`\nqueued  ${job.label}`)
  console.log(`        → ${job.destination}`)
  console.log('Render it with: pnpm queue --drain')
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
    const { path, seed, note, filed } = await renderWithBlock(block, renderTo, set)
    console.log(`rendered  ${path}${seed === undefined ? '' : `  seed ${seed}`}`)
    console.log(note)
    if (set) console.log(filed ? `filed into set ${set.run}` : `not filed into ${set.run} — the picture is there, the set is not`)
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
