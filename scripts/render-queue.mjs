#!/usr/bin/env node
/**
 * List, drain and tidy the render queue.
 *
 *     pnpm queue                 what is waiting
 *     pnpm queue --drain         render all of it, one job at a time
 *     pnpm queue --retry         put the failed ones back to pending
 *     pnpm queue --clear         forget the finished ones
 *     pnpm queue --clear --all   forget everything, pending included
 *
 * The point of the drain is that nobody is watching it. So it says what it did
 * per job rather than only at the end, writes the queue back after every one,
 * and — following the same rule the scanner follows — treats a job that fails
 * as a row with an error on it rather than as a reason to abandon the rest.
 */

import { existsSync } from 'node:fs'
import { fail, forge, renderWithBlock } from './lib/forge.mjs'
import { isPending, lock, queuePath, readJobs, writeJobs } from './lib/queue.mjs'

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
for (const flag of argv) {
  if (!['--drain', '--retry', '--clear', '--all'].includes(flag)) fail(`unknown argument: ${flag}`)
}

const jobs = readJobs()

if (jobs.length === 0 && !has('--clear')) {
  console.log('The queue is empty.')
  console.log(`  ${queuePath()}`)
  console.log('')
  console.log('Add to it by passing --queue where you would have rendered:')
  console.log('  pnpm open-in-forge --prompt "..." --queue --label face-closeup')
  process.exit(0)
}

// --- tidying ------------------------------------------------------------------

if (has('--retry')) {
  let revived = 0
  for (const job of jobs) {
    if (job.status === 'failed') {
      job.status = 'pending'
      delete job.error
      revived++
    }
  }
  writeJobs(jobs)
  console.log(`${revived} failed job${revived === 1 ? '' : 's'} back to pending.`)
  process.exit(0)
}

if (has('--clear')) {
  const kept = has('--all') ? [] : jobs.filter(isPending)
  writeJobs(kept)
  console.log(`Dropped ${jobs.length - kept.length}, kept ${kept.length}.`)
  process.exit(0)
}

// --- listing ------------------------------------------------------------------

const waiting = jobs.filter(isPending)

if (!has('--drain')) {
  const mark = { pending: '·', done: '✓', failed: '✗' }
  for (const job of jobs) {
    const detail =
      job.status === 'done'
        ? `  seed ${job.seed ?? '?'}`
        : job.status === 'failed'
          ? `  ${job.error}`
          : ''
    console.log(`${mark[job.status] ?? '?'} ${job.label}${detail}`)
  }
  console.log('')
  console.log(
    `${waiting.length} pending, ${jobs.filter((j) => j.status === 'done').length} done, ` +
      `${jobs.filter((j) => j.status === 'failed').length} failed.`,
  )
  if (waiting.length > 0) {
    // Measured on the 3090 this was written for: 32s per job at 832x1216 with
    // the 1.5x hires pass and an ADetailer face pass, with the checkpoint
    // already resident. The first job after a model switch pays the load on top,
    // so the range is one warm render to roughly double it.
    // In minutes until that stops being readable — "0.1–0.1 hours" is worse
    // than no estimate at all.
    const low = Math.max(1, Math.round(waiting.length * 0.5))
    const high = Math.max(low, Math.round(waiting.length))
    const span =
      waiting.length < 60
        ? `${low === high ? low : `${low}–${high}`} minute${high === 1 ? '' : 's'}`
        : `${(waiting.length / 120).toFixed(1)}–${(waiting.length / 60).toFixed(1)} hours`
    console.log(`Draining would take roughly ${span}. Run: pnpm queue --drain`)
  }
  process.exit(0)
}

// --- draining -----------------------------------------------------------------

if (waiting.length === 0) {
  console.log('Nothing pending.')
  process.exit(0)
}

const held = lock()
if (!held.ok) {
  fail(
    'Another drain is already running.',
    `  ${held.held}`,
    'If that is stale, delete render-queue.lock beside the queue file.',
  )
}

// Probed once, before anything is marked. Without this a Forge that is simply
// not running would fail every job in turn and the whole queue would come back
// in the morning marked failed — the one outcome worse than not running at all.
try {
  await forge('/sdapi/v1/progress')
} catch (error) {
  fail(
    `Forge is not answering: ${error.message}`,
    'The queue is untouched. Start Forge and run this again.',
  )
}

console.log(`Draining ${waiting.length} job${waiting.length === 1 ? '' : 's'}.`)
console.log('')

let done = 0
let failed = 0

for (const job of waiting) {
  const at = new Date().toLocaleTimeString()
  process.stdout.write(`[${at}] ${job.label} … `)
  try {
    const { path, seed } = await renderWithBlock(job.block, job.destination)
    job.status = 'done'
    job.seed = seed
    job.renderedAt = new Date().toISOString()
    done++
    console.log(`ok  seed ${seed ?? '?'}`)
    console.log(`         ${path}`)
  } catch (error) {
    // Forge answering with an HTTP status is *this job's* problem — a bad tag,
    // a checkpoint that is no longer installed — so it becomes a row and the
    // drain carries on. Anything else means the connection died under us, and
    // continuing would only convert the rest of the queue into failures for a
    // reason that has nothing to do with them.
    const isJobFailure = / returned \d{3}/.test(error.message)
    job.status = 'failed'
    job.error = error.message
    failed++
    console.log('failed')
    console.log(`         ${error.message}`)
    writeJobs(jobs)
    if (!isJobFailure) {
      console.log('')
      console.log('That looks like Forge going away rather than a bad job — stopping here.')
      console.log(`${done} rendered, ${failed} failed, ${waiting.length - done - failed} still pending.`)
      process.exit(1)
    }
  }
  // After every job, not at the end: an overnight run that is interrupted must
  // not lose the hours it already spent.
  writeJobs(jobs)
}

console.log('')
console.log(`${done} rendered, ${failed} failed.`)
if (done > 0) {
  console.log('Forge saved its own copies to its outputs folder, so the library will index them.')
}
if (failed > 0) console.log('Run `pnpm queue` to see why, then `pnpm queue --retry`.')
if (!existsSync(queuePath())) console.log('(queue file vanished mid-run)')
