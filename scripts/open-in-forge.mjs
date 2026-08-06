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

import {
  DEFAULT_MODEL,
  familyOf,
  warnAboutVPrediction,
  inspectCheckpoint,
  fail,
  openWithBlock,
  resolveModel,
  selectCheckpoint,
} from './lib/forge.mjs'

// A literal backslash-n becomes a real newline. pnpm on Windows cannot carry
// raw newlines through an argument — they arrive as the two characters
// backslash-n, which the tokenizer would read as text and which break BREAK,
// a keyword that must stand alone between whitespace. Callers therefore write
// backslash-n and this expands it, so multiline and BREAK-structured prompts
// survive the shell.
function unescape(value) {
  // Two passes: pnpm on Windows also doubles backslashes when re-quoting, so
  // the sequence can arrive as backslash-backslash-n. Expand first, then drop
  // any backslash left stranded against the newline it used to escape.
  return value == null ? value : value.replaceAll('\\n', '\n').replace(/\\+\n/g, '\n')
}

function parseArgs(argv) {
  const args = { model: DEFAULT_MODEL, width: 832, height: 1216, dryRun: false }
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
    else fail(`unknown argument: ${flag}`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.prompt) {
  fail(
    'usage: pnpm open-in-forge --prompt "..." [--negative "..."] [--model substring] [--width N --height N]',
    '',
    '  --model defaults to ' + DEFAULT_MODEL + '; --width/--height to 832x1216.',
    '  --dry-run prints the parameter block without touching Forge.',
  )
}
if (!Number.isFinite(args.width) || !Number.isFinite(args.height)) {
  fail('--width and --height must be numbers')
}

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
const sampler = vPred
  ? ['Sampler: Euler a']
  : ['Sampler: DPM++ 2M SDE', 'Schedule type: Karras']
if (vPred) warnAboutVPrediction(target.name)
const settings = [
  'Steps: 28',
  ...sampler,
  'CFG scale: 5',
  'Seed: -1',
  `Size: ${args.width}x${args.height}`,
  `Model: ${target.name}`,
  'Clip skip: 2',
  'Denoising strength: 0.4',
  'Hires upscale: 1.65',
  'Hires steps: 30',
  'Hires upscaler: 4xUltrasharp_4xUltrasharpV10',
  'ADetailer model: face_yolov8s.pt',
  args.adPrompt ? `ADetailer prompt: ${quote(args.adPrompt)}` : null,
  `ADetailer negative prompt: ${quote(args.adNegative ?? args.negative ?? 'worst quality, low quality, lowres')}`,
  'ADetailer denoising strength: 0.4',
].filter(Boolean).join(', ')

const block = [args.prompt, args.negative ? `Negative prompt: ${args.negative}` : null, settings]
  .filter(Boolean)
  .join('\n')

console.log(`model  ${target.name}  (${architecture})`)
console.log('')
console.log(block)

if (args.dryRun) {
  console.log('\ndry run: nothing selected, nothing opened.')
  process.exit(0)
}

await selectCheckpoint(target.name)
openWithBlock(block)
console.log('\nopened Forge with the prompt prefilled.')
