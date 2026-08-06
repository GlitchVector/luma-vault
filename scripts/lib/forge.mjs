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
  return /noob/i.test(name) ? 'noob' : undefined
}

/**
 * Say plainly that the webui may ignore what the checkpoint declares.
 *
 * A v-prediction checkpoint carries `v_pred` as a non-weight tensor, and
 * `huggingface_guess` — vendored into Forge — reads it and returns
 * `ModelType.V_PREDICTION`. That result is then used by **nothing**: on the
 * build measured here (`previous-224-g90019688`), `model_type()` has no callers
 * at all, and `backend/diffusion_engine/sdxl.py` builds its predictor from the
 * diffusers scheduler config of `stable-diffusion-xl-base-1.0`, which says
 * `prediction_type: epsilon`. So SDXL is always sampled as epsilon.
 *
 * The failure is loud but unattributed: saturated red-and-blue noise, no error
 * anywhere, and every setting in the block looking correct. Worth a warning
 * precisely because nothing else will mention it.
 */
export function warnAboutVPrediction(name) {
  console.error(
    `warning: ${name} is a v-prediction checkpoint.\n` +
      '  The block is written for it (Euler a), but the *mode* is the webui\'s to apply, and\n' +
      '  Forge builds around 2024 sample SDXL as epsilon regardless — the result is saturated\n' +
      '  red/blue noise rather than an error. If that is what comes out: update Forge, or use\n' +
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

/** Select the checkpoint in Forge — before any tab opens, or its dropdown
 *  renders empty over a correctly loaded model. */
export async function selectCheckpoint(name) {
  await forge('/luma/v1/checkpoint', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
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
