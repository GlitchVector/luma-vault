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

/** `sd`, `xl` or `flux`, from the tensor names in the safetensors header. */
export function architectureOf(file) {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(8)
    readSync(fd, head, 0, 8, 0)
    const length = Number(head.readBigUInt64LE(0))
    if (length <= 0 || length > 64 * 1024 * 1024) return 'sd'
    const json = Buffer.alloc(length)
    readSync(fd, json, 0, length, 8)
    const keys = Object.keys(JSON.parse(json.toString('utf8')))
    if (keys.some((key) => key.includes('double_blocks.'))) return 'flux'
    // SDXL is the one with a second text encoder.
    return keys.some((key) => key.startsWith('conditioner.embedders.1.')) ? 'xl' : 'sd'
  } catch {
    return 'sd'
  } finally {
    closeSync(fd)
  }
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
