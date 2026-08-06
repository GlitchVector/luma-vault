/**
 * The Forge plumbing shared by every script that opens a prefilled tab.
 *
 * Extracted from migrate-prompt.mjs when open-in-forge.mjs arrived: checkpoint
 * resolution and architecture sniffing are exactly the kind of logic that
 * drifts when two scripts each carry a copy — one learns about flux, the other
 * keeps guessing `sd`.
 */

import { spawn } from 'node:child_process'
import { openSync, readSync, closeSync, statSync } from 'node:fs'

export const FORGE = process.env.LUMA_FORGE_URL ?? 'http://127.0.0.1:7860'

export function fail(...lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

export async function forge(path, options) {
  const response = await fetch(FORGE + path, options)
  if (!response.ok) throw new Error(`${path} returned ${response.status}`)
  return response.json()
}

/**
 * What a checkpoint says about itself, from one read of its safetensors header.
 *
 * Both answers come from the same parse because both are in the same place: the
 * header lists every tensor, and a v-prediction checkpoint carries `v_pred` as
 * a **non-weight** entry beside them — NoobAI's v-pred release also carries
 * `ztsnr`. That is not a convention this app invented; it is what Forge and
 * A1111 detect the mode from, which is why nothing has to be configured for
 * the webui and the block to agree.
 */
export function inspectCheckpoint(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(8)
    readSync(fd, head, 0, 8, 0)
    const length = Number(head.readBigUInt64LE(0))
    if (length <= 0 || length > 64 * 1024 * 1024) return { architecture: 'sd', vPred: false }
    const json = Buffer.alloc(length)
    readSync(fd, json, 0, length, 8)
    const keys = Object.keys(JSON.parse(json.toString('utf8')))

    const architecture = keys.some((key) => key.includes('double_blocks.'))
      ? 'flux'
      : // SDXL is the one with a second text encoder.
        keys.some((key) => key.startsWith('conditioner.embedders.1.'))
        ? 'xl'
        : 'sd'
    return { architecture, vPred: keys.includes('v_pred') }
  } catch {
    // A header that cannot be read is not a reason to refuse the migration:
    // `sd` is the conservative reading, and epsilon is the common case.
    return { architecture: 'sd', vPred: false }
  } finally {
    closeSync(fd)
  }
}

/** `sd`, `xl` or `flux`, from the tensor names in the safetensors header. */
export function architectureOf(file) {
  return inspectCheckpoint(file).architecture
}

/**
 * Which booru vocabulary a checkpoint was trained on, from its filename.
 *
 * By name, unlike everything else here, because there is nothing in the file
 * that says it — the tensors of a NoobAI checkpoint and an Illustrious one are
 * identically shaped. A wrong guess costs a slightly different set of quality
 * tags, which is why a heuristic is acceptable at all.
 */
export function familyOf(name) {
  if (/noob/i.test(name)) return 'noob'
  if (/hassaku/i.test(name)) return 'hassaku'
  if (/aniverse/i.test(name)) return 'aniverse'
  return undefined
}

/**
 * The settings and activation token a family wants, from its model card.
 *
 * AniVerse XL is the one that differs from the booru-XL default here. Its card
 * asks for CFG 5.5, 30 steps and `DPM++ 2M` with the Karras scheduler — the
 * SDE variant is a different sampler, and the creator names 2M specifically as
 * the one that gives colour, detail and a 2.5D result.
 *
 * `trigger` matters more than any of the numbers: without `4n1v3rs3` the
 * trained style is never engaged, and the same prompt comes back looking like
 * base SDXL each time, which reads as the model being inconsistent.
 */
export function settingsFor(family, architecture) {
  // Gated on the architecture, not only the name. `aniverse` matches several
  // installed checkpoints here and the newest by date is an **SD1.5** one —
  // which would otherwise be handed the XL card's CFG and sampler, a tuning
  // for a model it is not. The name says which family; the file says whether
  // the card applies.
  if (architecture !== 'xl') return null
  if (family === 'aniverse') {
    return { cfg: 5.5, steps: 30, sampler: 'DPM++ 2M', schedule: 'Karras', trigger: '4n1v3rs3' }
  }
  if (family === 'hassaku') {
    // CFG is the one the sources disagree about — 7 on a Hassaku-specific
    // page, 4.5-5 in the Illustrious guides, usable range 3-7. 5 is inside
    // both, and `--cfg 7` tries the other reading.
    return { cfg: 5, steps: 28, sampler: 'Euler a', schedule: 'Automatic' }
  }
  return null
}

/**
 * Name the one failure a parameter block cannot prevent, and its symptom.
 *
 * A v-prediction checkpoint carries `v_pred` as a non-weight tensor. Whether
 * that is *acted on* is the webui's business, and older builds do not: before
 * mid-2025 Forge read the marker through its vendored `huggingface_guess` and
 * then called nothing with the answer, taking its predictor from the diffusers
 * scheduler config of `stable-diffusion-xl-base-1.0` — `epsilon` — so every
 * SDXL was sampled as epsilon. Current builds map it properly in
 * `backend/loader.py`.
 *
 * Stated as a symptom rather than a verdict, because the script cannot tell
 * which build is answering on the other end of the port, and asserting the
 * wrong one is worse than describing what to look for. Nothing else will
 * mention it: the render fails loudly and attributes itself to nothing.
 */
export function warnAboutVPrediction(name) {
  console.error(
    `note: ${name} is a v-prediction checkpoint — the block asks for Euler a, but applying\n` +
      '  the prediction mode is the webui\'s job. If the result is saturated red-and-blue\n' +
      '  noise, this Forge is sampling it as epsilon: update Forge (fixed mid-2025), or use\n' +
      '  an Epsilon-pred release of the same model.',
  )
}

/** The newest installed checkpoint whose name contains `wanted`. */
export async function resolveModel(wanted) {
  const installed = await forge('/luma/v1/checkpoints')
  const matches = installed.filter((entry) =>
    entry.name.toLowerCase().includes(wanted.toLowerCase()),
  )
  if (matches.length === 0) {
    fail(
      `No installed checkpoint matches "${wanted}". Installed:`,
      ...installed.map((entry) => '  ' + entry.name),
    )
  }
  // Newest by file date — "the latest one I have" is a question about the
  // filesystem, not about version numbers in names, which are not comparable
  // across authors.
  matches.sort((a, b) => statSync(b.filename).mtimeMs - statSync(a.filename).mtimeMs)
  return matches[0]
}

/**
 * Whether Forge is generating right now.
 *
 * Unreachable counts as idle: a Forge that is not running cannot be disturbed,
 * and refusing to work because the status call failed would be worse than the
 * thing being guarded against.
 */
export async function isGenerating() {
  try {
    const progress = await forge('/sdapi/v1/progress')
    const job = progress?.state ?? {}
    return Number(job.job_count ?? 0) > 0 || Number(progress?.progress ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Select the checkpoint in Forge — before any tab opens, or its dropdown
 * renders empty over a correctly loaded model.
 *
 * **Refused while a generation is running, and that is not politeness.** The
 * checkpoint is a global setting, and `modules/processing.py` calls
 * `forge_model_reload()` *inside* the batch loop — every iteration re-resolves
 * the model from that global. So selecting one here while a batch is going
 * changes the model out from under it, and the rest of the batch comes out in
 * a different style with nothing to explain why. It is not an error anyone
 * sees; it is images quietly not being what was asked for.
 *
 * The tab still opens when this refuses. Its block names the model, so the
 * switch happens when that tab generates — after the batch, which is when it
 * was wanted anyway.
 *
 * @returns whether the checkpoint was actually selected.
 */
export async function selectCheckpoint(name) {
  if (await isGenerating()) {
    console.error(
      `note: Forge is mid-generation, so ${name} was NOT selected — switching now would change\n` +
        '  the model under the running batch and the rest of it would come out in another style.\n' +
        '  The tab still opens and its block names the model, so it switches when you generate there.',
    )
    return false
  }
  await forge('/luma/v1/checkpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  return true
}

/** Open Forge with a parameter block in the fragment, for the prefill
 *  extension. A fragment never leaves the browser, so the prompt stays out of
 *  Forge's request log. */
export function openWithBlock(block) {
  const url = `${FORGE}/#luma_params=${encodeURIComponent(block)}`
  const opener =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref()
}

/**
 * The model used when none is named.
 *
 * Naming the model is the part of this you almost never want to think about —
 * there is usually one checkpoint you are moving everything onto, and typing it
 * every time is friction on the common case. Still a substring, so `deliberate`
 * keeps picking the newest installed checkpoint whose filename contains it
 * rather than pinning a version.
 */
export const DEFAULT_MODEL = 'deliberate'
