/**
 * The manifest: `post.json` next to a set of media files.
 *
 * Parse at the boundary, never cast — so this is the only place that turns
 * whatever is on disk into a value the rest of the client trusts.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { ManifestError } from './errors.ts'

/**
 * `adult` is `.optional()`-free and has no `.default()`, on purpose. The
 * content is NSFW; a missing flag falling back to `false` is an account-level
 * problem, not a warning. Undefined must be a hard parse failure.
 */
export const manifestSchema = z.object({
  title: z.string().min(1),
  /** Inline post body, or a path (relative to the set) to a `.md` file holding it. */
  body: z.string(),
  /** File names relative to the set directory. Order is the order they are attached in. */
  media: z.array(z.string().min(1)).min(1),
  /** Which of `media` is the public teaser image. Optional; no teaser is a legitimate choice. */
  teaser: z.string().min(1).optional(),
  access: z.enum(['public', 'tier']),
  /**
   * Required and non-empty when `access` is `tier`.
   *
   * These are **access-rule ids, not tier ids** — a distinction the brief's
   * schema did not make and the `tier-locked` capture did. The editor sends
   * `data.relationships.access_rules.data: [{ type: 'access-rule', id }]` with a
   * matching `included` entry; public and paid are two different access-rule
   * ids on the same campaign, so "public" is not the absence of a rule, it is a
   * rule of its own.
   *
   * TODO: a `patreon tiers` command that lists a campaign's access rules, so
   * these ids can be looked up rather than dug out of a capture by hand.
   */
  tiers: z.array(z.string().min(1)).optional(),
  adult: z.boolean({ error: 'adult is required and has no default — state it explicitly' }),
})

export type Manifest = z.infer<typeof manifestSchema>

/** A manifest that has been read, cross-checked and had every path resolved to a real file. */
export interface ResolvedPost {
  /** Directory holding `post.json` and the media. */
  readonly dir: string
  readonly manifestPath: string
  readonly title: string
  /** Body text, with a `body: "notes.md"` reference already read off disk. */
  readonly body: string
  readonly media: readonly ResolvedMedia[]
  readonly teaser: ResolvedMedia | null
  readonly access: 'public' | 'tier'
  readonly tiers: readonly string[]
  readonly adult: boolean
}

export interface ResolvedMedia {
  /** As written in the manifest — the key used in `.state.json`. */
  readonly name: string
  readonly path: string
  readonly bytes: number
  /**
   * Last-write time, in ms. Together with `bytes` this is the resume identity:
   * a re-exported file gets a new mtime and so loses its uploaded media id,
   * which is the behaviour we want and costs nothing. Hashing 400MB to learn
   * the same thing does not.
   */
  readonly modifiedMs: number
  readonly kind: 'image' | 'video'
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i
const VIDEO = /\.(mp4|mov|m4v|webm|mkv)$/i

export function kindOf(name: string): 'image' | 'video' | null {
  if (IMAGE.test(name)) return 'image'
  if (VIDEO.test(name)) return 'video'
  return null
}

/**
 * Read and validate `post.json` in `dir`.
 *
 * Every problem is collected and reported together. A set is edited by hand;
 * being told about the missing tier id only after fixing the typo'd filename is
 * three round trips where one would do.
 */
export async function loadManifest(dir: string): Promise<ResolvedPost> {
  const setDir = resolve(dir)
  const manifestPath = resolve(setDir, 'post.json')

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (cause) {
    throw new ManifestError(manifestPath, [
      cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
        ? 'no post.json here'
        : `not valid JSON: ${(cause as Error).message}`,
    ])
  }

  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ManifestError(
      manifestPath,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    )
  }
  const manifest = parsed.data
  const problems: string[] = []

  if (manifest.access === 'tier' && (manifest.tiers ?? []).length === 0) {
    problems.push('access is "tier" but no tiers are listed — that would lock the post to nobody')
  }
  if (manifest.access === 'public' && (manifest.tiers ?? []).length > 0) {
    problems.push('access is "public" but tiers are listed — one of the two is a mistake')
  }

  const body = await resolveBody(setDir, manifest.body, problems)

  // Stat everything up front rather than inside the loop below: a set is a few
  // dozen files on a network share, and doing it one at a time is one round trip
  // each. Names that fail the shape check are not statted at all — nothing here
  // should reach outside the set, even read-only.
  const inside = (name: string) => !isAbsolute(name) && !name.includes('..')
  const stats = new Map(
    await Promise.all(
      manifest.media
        .filter(inside)
        .map(async (name) => [name, await stat(resolve(setDir, name)).catch(() => null)] as const),
    ),
  )

  const seen = new Set<string>()
  const media: ResolvedMedia[] = []
  for (const name of manifest.media) {
    if (seen.has(name)) {
      problems.push(`media lists ${name} twice`)
      continue
    }
    seen.add(name)

    if (!inside(name)) {
      problems.push(`media ${name}: must be a plain file name inside the set`)
      continue
    }
    const kind = kindOf(name)
    if (kind === null) {
      problems.push(`media ${name}: not a file type Patreon takes as an attachment`)
      continue
    }
    const path = resolve(setDir, name)
    const info = stats.get(name) ?? null
    if (info === null || !info.isFile()) {
      problems.push(`media ${name}: no such file in ${setDir}`)
      continue
    }
    if (info.size === 0) {
      problems.push(`media ${name}: is empty`)
      continue
    }
    media.push({ name, path, bytes: info.size, modifiedMs: info.mtimeMs, kind })
  }

  let teaser: ResolvedMedia | null = null
  if (manifest.teaser !== undefined) {
    teaser = media.find((item) => item.name === manifest.teaser) ?? null
    if (teaser === null) {
      problems.push(`teaser ${manifest.teaser} is not one of the media files`)
    } else if (teaser.kind !== 'image') {
      problems.push(`teaser ${manifest.teaser} is a video — the teaser is the still shown to non-patrons`)
    }
  }

  if (problems.length > 0) throw new ManifestError(manifestPath, problems)

  return {
    dir: setDir,
    manifestPath,
    title: manifest.title,
    body,
    media,
    teaser,
    access: manifest.access,
    tiers: manifest.tiers ?? [],
    adult: manifest.adult,
  }
}

/**
 * `body` is either the text itself or the name of a markdown file holding it.
 * The discriminator is the extension, so a body that genuinely is the single
 * word "notes.md" is not expressible — an acceptable trade for not needing a
 * second field.
 */
async function resolveBody(setDir: string, body: string, problems: string[]): Promise<string> {
  if (!/\.mdx?$/i.test(body.trim())) return body
  const name = body.trim()
  if (isAbsolute(name) || name.includes('..')) {
    problems.push(`body ${name}: must be a plain file name inside the set`)
    return ''
  }
  const path = resolve(setDir, basename(name))
  try {
    return await readFile(path, 'utf8')
  } catch {
    problems.push(`body ${name}: no such file in ${dirname(path)}`)
    return ''
  }
}
