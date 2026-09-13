/**
 * A post the app assembled, rather than one a person wrote by hand.
 *
 * `manifest.ts` reads a `post.json` somebody typed: media are plain file names
 * inside the set directory, and anything else is refused, because a
 * hand-written file naming `../../` has no honest reading.
 *
 * A job is the other case. The desktop app already resolved a selection of
 * media ids to absolute paths out of its own index — it is not quoting a string
 * a human typed, it is naming files it just looked up. Those paths do not live
 * in one directory and never will: a selection can span folders, dates and
 * drives. So the job carries absolute paths and the manifest's rule stays
 * exactly as strict as it was.
 *
 * The two converge on `ResolvedPost`, so everything downstream — the plan, the
 * run, the state file — cannot tell which way a post arrived.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { ManifestError } from './errors.ts'
import { kindOf, type ResolvedMedia, type ResolvedPost } from './manifest.ts'

export const jobSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1),
  /** Already resolved: a job never names a file to be read later. */
  body: z.string(),
  /** Absolute paths, in the order they should appear in the post. */
  media: z.array(z.string().min(1)).min(1),
  access: z.enum(['public', 'tier']),
  tiers: z.array(z.string().min(1)).optional(),
  adult: z.boolean({ error: 'adult is required and has no default — state it explicitly' }),
  /**
   * Where to keep the resume state.
   *
   * Named rather than derived, and this is not fussiness: a set lives inside a
   * watched folder, and dropping a `.state.json` beside the pictures would have
   * the app's own watcher index a file the app is writing. The app points this
   * at its data directory instead.
   */
  stateFile: z.string().min(1),
})

export type Job = z.infer<typeof jobSchema>

/** Read a job file and resolve it into the same shape a manifest produces. */
export async function loadJob(path: string): Promise<ResolvedPost> {
  const jobPath = resolve(path)

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(jobPath, 'utf8'))
  } catch (cause) {
    throw new ManifestError(jobPath, [`not a readable job file: ${(cause as Error).message}`])
  }

  const parsed = jobSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ManifestError(
      jobPath,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  const job = parsed.data
  const problems: string[] = []

  if (job.access === 'tier' && (job.tiers ?? []).length === 0) {
    problems.push('access is "tier" but no tiers are listed — that would lock the post to nobody')
  }

  const stats = await Promise.all(
    job.media.map(async (each) => [each, await stat(each).catch(() => null)] as const),
  )

  const media: ResolvedMedia[] = []
  const seen = new Set<string>()
  for (const [file, info] of stats) {
    if (!isAbsolute(file)) {
      problems.push(`${file}: a job names absolute paths`)
      continue
    }
    if (seen.has(file)) {
      problems.push(`${file} appears twice`)
      continue
    }
    seen.add(file)

    const name = basename(file)
    const kind = kindOf(name)
    if (kind === null) {
      problems.push(`${name}: not a file type Patreon takes as an attachment`)
      continue
    }
    if (info === null || !info.isFile()) {
      problems.push(`${file}: no such file`)
      continue
    }
    if (info.size === 0) {
      problems.push(`${name}: is empty`)
      continue
    }
    media.push({ name, path: file, bytes: info.size, modifiedMs: info.mtimeMs, kind })
  }

  // Two files from different folders can share a name, and the state file is
  // keyed by name. Left as a hard error rather than silently renamed: the app
  // picked these, so it can pick again.
  const names = media.map((each) => each.name)
  const duplicates = [...new Set(names.filter((name, at) => names.indexOf(name) !== at))]
  if (duplicates.length > 0) {
    problems.push(`two files share the name ${duplicates.join(', ')} — rename one, or drop it from the post`)
  }

  if (problems.length > 0) throw new ManifestError(jobPath, problems)

  return {
    dir: jobPath,
    manifestPath: jobPath,
    title: job.title,
    body: job.body,
    media,
    preview: media[0] ?? null,
    access: job.access,
    tiers: job.tiers ?? [],
    adult: job.adult,
    stateFile: resolve(job.stateFile),
  }
}
