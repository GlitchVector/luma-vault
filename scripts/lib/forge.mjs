/**
 * The Forge plumbing shared by every script that opens a prefilled tab.
 *
 * Extracted from migrate-prompt.mjs when open-in-forge.mjs arrived: checkpoint
 * resolution and architecture sniffing are exactly the kind of logic that
 * drifts when two scripts each carry a copy — one learns about flux, the other
 * keeps guessing `sd`.
 */

import { spawn } from 'node:child_process'
import { openSync, readSync, closeSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const FORGE = process.env.LUMA_FORGE_URL ?? 'http://127.0.0.1:7860'

/**
 * Whether Forge is somewhere else — a rented GPU, a machine in another room.
 *
 * Three things stop being true when it is, and each fails silently rather than
 * loudly, which is why this is worth knowing rather than discovering:
 *
 * - `filename` in a checkpoint listing is a path **over there**. Statting it
 *   throws, and reading it for the architecture returns nothing.
 * - `save_images` files Forge's own copy on **that** machine, so the copy that
 *   normally puts a render into the library never appears here.
 * - The render still comes back — the bytes travel base64 in the response — so
 *   nothing errors and the picture simply never gets indexed.
 */
export const IS_REMOTE = !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(FORGE)

/** Where a remote render is copied so the library still sees it. */
export const RENDER_DIR = process.env.LUMA_RENDER_DIR

export function fail(...lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/**
 * A literal backslash-n in an argument becomes a real newline.
 *
 * pnpm on Windows cannot carry raw newlines through an argument — they arrive
 * as the two characters backslash-n, which the tokenizer would read as text and
 * which break `BREAK`, a keyword that must stand alone between whitespace. So
 * callers write backslash-n and this expands it, and multiline prompts survive
 * the shell.
 *
 * Two passes, because pnpm on Windows also doubles backslashes when re-quoting:
 * the sequence can arrive as backslash-backslash-n. Expand first, then drop any
 * backslash left stranded against the newline it used to escape.
 */
export function unescapeNewlines(value) {
  return value == null ? value : value.replaceAll('\\n', '\n').replace(/\\+\n/g, '\n')
}

export async function forge(path, options) {
  const response = await fetch(FORGE + path, options)
  if (!response.ok) {
    // The body, not only the status. Forge answers a failed generation with a
    // 500 whose payload names the actual exception — and a render can queue
    // for minutes behind a batch before failing, so throwing away the one line
    // that says why costs another full wait to find out.
    let detail = ''
    try {
      const body = await response.text()
      const parsed = JSON.parse(body)
      detail = parsed?.detail ?? parsed?.error ?? parsed?.errors ?? body
    } catch {
      detail = ''
    }
    const said = String(detail).replace(/\s+/g, ' ').trim().slice(0, 400)
    throw new Error(`${path} returned ${response.status}${said ? `: ${said}` : ''}`)
  }
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
  // `openSync` inside the try, not before it. Outside, an unreadable path threw
  // straight past the catch — so a checkpoint on another machine did not
  // degrade to a guess, it took the whole command down with an ENOENT naming a
  // path that does not exist here and explaining nothing.
  let fd
  try {
    fd = openSync(file, 'r')
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
    // **`null`, not a guess.** This used to answer `sd` on any failure, which
    // reads as conservative and is not: `settingsFor` gates the family tuning
    // on `xl`, so an unreadable file quietly cost the Illustrious sampler and
    // CFG and the render came back on DPM++ 2M SDE Karras with nothing saying
    // why. Unreadable is a different fact from "looks like SD1.5" and the
    // caller has to be able to tell them apart — see `describeCheckpoint`.
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** `sd`, `xl` or `flux`, from the tensor names in the safetensors header. */
export function architectureOf(file) {
  return inspectCheckpoint(file)?.architecture
}

/**
 * What a checkpoint is, from whoever can actually see the file.
 *
 * Three sources, in descending order of trust:
 *
 * 1. **What Forge reported.** The extension reads the header on the machine
 *    that holds the checkpoint, so this is the only source that works when
 *    Forge is remote. Older installs of the extension do not send it.
 * 2. **The file, read here.** Correct whenever Forge is local.
 * 3. **The name.** Every family this app knows — Illustrious, NoobAI, AniVerse
 *    — is SDXL, so a name that matches one is XL. Said out loud, because a
 *    guess sitting in a block looks exactly like a fact.
 *
 * When all three come up empty it still answers `xl` rather than `sd`, and
 * warns. Every checkpoint this workflow targets is XL; the old silent `sd` was
 * wrong far more often than it was right, and it was wrong invisibly.
 */
export function describeCheckpoint(entry) {
  if (entry.architecture) {
    return { architecture: entry.architecture, vPred: Boolean(entry.v_pred) }
  }
  const read = inspectCheckpoint(entry.filename)
  if (read) return read

  const family = familyOf(entry.name)
  console.error(
    `note: could not read ${entry.name}'s header${IS_REMOTE ? ' — Forge is remote, so its file is not on this machine' : ''}.\n` +
      (family
        ? `  Assuming xl, because the name says ${family} and every family here is SDXL.`
        : '  Assuming xl, which is what this workflow targets — but nothing confirmed it.') +
      '\n  Update the Forge extension (pnpm setup:forge, then restart Forge) and it will report this itself.',
  )
  return { architecture: 'xl', vPred: false, guessed: true }
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
  // Every Illustrious checkpoint installed here, by the names they ship under.
  // PerfectDeliberate is one too — its Civitai page lists it as an Illustrious
  // checkpoint — and treating it as generic XL was an accident of the name not
  // containing the word, not a fact about the model.
  if (/hassaku|illustrious|perfectdeliberate/i.test(name)) return 'illustrious'
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
  if (family === 'illustrious') {
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
  //
  // Whose filesystem, though. `filename` is a path on the machine running
  // Forge, so statting it here throws the moment Forge is remote and two
  // checkpoints match — a crash in the middle of a substring lookup, for a
  // reason nothing on screen would explain. The extension reports `mtime`
  // precisely so a remote caller can still order them; only fall back to
  // statting when every entry lacks it, so the two units are never mixed.
  if (matches.length > 1) {
    if (matches.every((entry) => typeof entry.mtime === 'number')) {
      matches.sort((a, b) => b.mtime - a.mtime)
    } else {
      const local = (entry) => {
        try {
          return statSync(entry.filename).mtimeMs
        } catch {
          return 0
        }
      }
      const dated = matches.map(local)
      if (dated.every((at) => at === 0)) {
        console.error(
          `note: ${matches.length} checkpoints match "${wanted}" and none of their dates could be read` +
            `${IS_REMOTE ? ' — Forge is remote' : ''}, so "newest" is whatever order Forge listed.\n` +
            `  Taking ${matches[0].name}. Name one specifically, or update the Forge extension.`,
        )
      } else {
        matches.sort((a, b) => local(b) - local(a))
      }
    }
  }
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
 * Generate the block instead of opening it in a tab, and write the result.
 *
 * The `-multi` commands' way out of the queue problem. A Forge page's `load`
 * handler runs on Gradio's queue, which drains one event at a time, so a row of
 * tabs past the second sits on "Loading…" waiting for each other — measured
 * wedging identically at a five-second stagger and at ten. An API request has
 * no page to load: it queues as *work*, behind whatever is generating, and
 * comes back with the picture.
 *
 * **Which copy ends up in the library depends on where Forge is.** Locally,
 * `save_images` files one in Forge's own outputs with its own numbering, and
 * that is the copy the watcher picks up; the one written here is only so the
 * caller has a path to show, and it goes to a scratch directory outside any
 * watched folder so nothing is indexed twice.
 *
 * Remotely, that arrangement quietly stops working: Forge's own copy lands on
 * *that* machine and the picture never reaches the library, while the request
 * still succeeds and the render still appears in the scratchpad. So when Forge
 * is remote, `save_images` is off — it would only fill a rented disk — and the
 * bytes that came back are written into `LUMA_RENDER_DIR` instead, which is
 * expected to be a watched folder.
 *
 * No checkpoint selection beforehand: `toApiPayload` sends the model in
 * `override_settings`, per request. That is also why this is safe to call while
 * a batch runs, where `selectCheckpoint` would refuse.
 *
 * @returns the scratch path, the seed, and the sentence to print about where
 *   the library's copy came from — which the caller cannot work out itself.
 */
export async function renderWithBlock(block, destination) {
  const { toApiPayload } = await import('../../packages/core/src/migrate.ts')
  const answer = await forge('/sdapi/v1/txt2img', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...toApiPayload(block), save_images: !IS_REMOTE }),
  })
  const image = answer?.images?.[0]
  if (!image) throw new Error('Forge accepted the request but returned no image')
  // The data URI prefix is present on some builds and absent on others.
  const bytes = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  writeFileSync(destination, bytes)

  let note = 'Forge saved its own copy to its outputs folder, so the library will index it.'
  if (IS_REMOTE) {
    if (RENDER_DIR) {
      mkdirSync(RENDER_DIR, { recursive: true })
      const filed = join(RENDER_DIR, basename(destination))
      writeFileSync(filed, bytes)
      note = `Forge is remote, so its own copy stayed there — filed here instead:\n  ${filed}`
    } else {
      note =
        'Forge is remote, so its own copy stayed on that machine and nothing has been\n' +
        '  added to the library. Set LUMA_RENDER_DIR to a watched folder to have renders filed.'
    }
  }

  let seed
  try {
    seed = JSON.parse(answer.info)?.seed
  } catch {
    // The info blob is a convenience, not the result. A build that changes its
    // shape must not cost us the picture we already have on disk.
  }
  return { path: destination, seed, note }
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

/**
 * The canvas both commands use unless the caller overrides it: the portrait
 * SDXL bucket.
 *
 * Deliberately *not* derived from the source image's aspect. What these prompts
 * are for is a standing figure, and a source's shape is an accident of whatever
 * it came from — an img2img chain that passed through a square crop, a wallpaper
 * someone saved. Inheriting it produced square and landscape canvases nobody had
 * asked for, and a body prompt on a landscape canvas crops at the waist.
 */
export const PORTRAIT = '832x1216'
export const [PORTRAIT_WIDTH, PORTRAIT_HEIGHT] = PORTRAIT.split('x').map(Number)
