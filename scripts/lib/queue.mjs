/**
 * The render queue: jobs written now, generated later.
 *
 * A 3090 under load is loud enough to be antisocial, so the useful unit of work
 * is not "render this" but "render this when nobody is listening". Everything
 * here exists to move the noisy part of the pipeline to a time of the user's
 * choosing without changing anything about what gets rendered.
 *
 * A job is a **parameter block and a destination**, and that is the whole
 * design. By the time either command has a block, model resolution, framing
 * enforcement, the undress rules, the family tuning and the style flag have all
 * already been applied — the block is self-contained and reproduces byte for
 * byte what a live `--render` would have sent. So the queue stores no flags, no
 * image name and no model: replaying a job cannot drift from what was queued,
 * because there is nothing left to re-derive.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the queue lives — beside the index, not in the repo.
 *
 * `migrate-prompt` *searches* the three platform locations because the index is
 * written by the app and it has to find whichever one exists. This picks by
 * platform instead: the queue is ours, nothing else creates it, and searching
 * for a file that does not exist yet would only ever fail.
 */
export function dataDir() {
  const dir =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'net.glitchvector.luma-vault')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'net.glitchvector.luma-vault')
        : join(homedir(), '.local', 'share', 'net.glitchvector.luma-vault')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function queuePath() {
  return join(dataDir(), 'render-queue.jsonl')
}

/**
 * Where a drained job's picture is written when the caller named no path.
 *
 * Deliberately outside any watched folder. Forge saves its own copy into its
 * outputs with its own numbering, and that copy is what the library indexes —
 * writing here too would index the same picture twice. This one exists so there
 * is a predictable place to look through the night's work in the morning.
 */
export function outputDir() {
  const dir = join(dataDir(), 'queue-out')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** JSONL rather than one JSON array: appending a job must not require reading,
 *  parsing and rewriting a file that a drain may be holding open. */
export function readJobs() {
  const path = queuePath()
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, at) => {
      try {
        return JSON.parse(line)
      } catch {
        // A truncated last line is what a killed drain leaves behind. Dropping
        // it loses one job; refusing to read loses the whole queue.
        console.error(`note: skipping unreadable queue line ${at + 1}`)
        return null
      }
    })
    .filter(Boolean)
}

export function writeJobs(jobs) {
  writeFileSync(queuePath(), jobs.map((job) => JSON.stringify(job)).join('\n') + '\n')
}

export function enqueue({ label, block, destination }) {
  const job = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    block,
    destination: destination ?? join(outputDir(), `${label}.png`),
    status: 'pending',
    queuedAt: new Date().toISOString(),
  }
  appendFileSync(queuePath(), JSON.stringify(job) + '\n')
  return job
}

export const isPending = (job) => job.status === 'pending'

/**
 * One drain at a time.
 *
 * Two drains would not corrupt anything Forge does — it queues the requests —
 * but they would both rewrite the queue file from their own stale copy, and the
 * loser's results vanish. A scheduled nightly run plus an impatient manual one
 * is exactly how that happens.
 */
export function lock() {
  const path = join(dataDir(), 'render-queue.lock')
  if (existsSync(path)) {
    const held = readFileSync(path, 'utf8').trim()
    return { ok: false, held }
  }
  writeFileSync(path, `pid ${process.pid} since ${new Date().toISOString()}`)
  const release = () => {
    try {
      rmSync(path, { force: true })
    } catch {
      // Losing the lock file is not worth failing a completed drain over; the
      // next run says who held it and the user can delete it.
    }
  }
  process.on('exit', release)
  process.on('SIGINT', () => {
    release()
    process.exit(130)
  })
  return { ok: true, release }
}
