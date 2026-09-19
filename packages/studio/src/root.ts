/**
 * Where the studio's content lives, and how a fresh root is laid out.
 *
 * The content root is a folder outside this repository (`STUDIO_ROOT`,
 * default `D:\Development\comic-studio`), because luma-vault is public and
 * a character's canon is not. Everything in it is Markdown and YAML that a
 * person can read, diff and version with git; nothing here is a database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'

export const DEFAULT_ROOT = 'D:\\Development\\comic-studio'

/** A path the person typed, against the directory they typed it in. */
export function resolveUserPath(given: string): string {
  return isAbsolute(given) ? given : resolve(process.env['INIT_CWD'] ?? process.cwd(), given)
}

export function studioRoot(given?: string): string {
  const root = given ?? process.env['STUDIO_ROOT'] ?? DEFAULT_ROOT
  return isAbsolute(root) ? root : resolve(process.env['INIT_CWD'] ?? process.cwd(), root)
}

/** The canon files every character has, in the order the plan lists them. */
export const CHARACTER_FILES = [
  'core',
  'appearance',
  'personality',
  'history',
  'interests',
  'relationships',
  'sexuality',
  'humor',
  'speech',
  'boundaries',
  'outfits',
  'current_state',
] as const
export type CharacterFile = (typeof CHARACTER_FILES)[number]

export const modelConfigSchema = z.object({
  /** `openai-compatible` speaks to Ollama, LM Studio and llama.cpp alike;
   *  `claude-cli` is the fallback on a machine without a local model. */
  backend: z.enum(['openai-compatible', 'claude-cli']).default('claude-cli'),
  url: z.string().default('http://127.0.0.1:11434/v1'),
  model: z.string().default('claude-opus-5'),
  /** Name of the environment variable holding the key, if the server wants one. */
  api_key_env: z.string().default('STUDIO_MODEL_KEY'),
  temperature: z.number().min(0).max(2).default(0.9),
})

export const configSchema = z.object({
  model: modelConfigSchema.prefault({}),
  /** How many proposals a brainstorm asks for unless told otherwise. */
  proposals: z.number().int().min(1).max(20).default(5),
})
export type Config = z.infer<typeof configSchema>

export interface Studio {
  root: string
  config: Config
}

export function openStudio(given?: string): Studio {
  const root = studioRoot(given)
  if (!existsSync(join(root, 'studio.config.json'))) {
    throw new Error(`${root} is not a studio root (no studio.config.json) — run \`pnpm studio init\` there first`)
  }
  const raw = JSON.parse(readFileSync(join(root, 'studio.config.json'), 'utf8'))
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`studio.config.json: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return { root, config: parsed.data }
}

export function characterDir(studio: Studio, id: string): string {
  return join(studio.root, 'characters', id)
}

export function comicDir(studio: Studio, id: string): string {
  return join(studio.root, 'comics', id)
}

/** Ids are folder names this module builds paths from: a strict allowlist,
 *  never escaping. */
export function validId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}

export function assertId(id: string, what: string): void {
  if (!validId(id)) throw new Error(`"${id}" is not a ${what} id: lower-case letters, digits, dashes and underscores`)
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

export function writeText(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** Only writes when the file is missing: a scaffold never overwrites canon. */
function seed(path: string, text: string): boolean {
  if (existsSync(path)) return false
  writeText(path, text)
  return true
}

function stub(title: string, hint: string): string {
  return `# ${title}\n\n_Nothing established yet. ${hint}_\n`
}

/**
 * Lay out a root. Idempotent: existing files are never touched, so this is
 * also how a root made by hand gets any folder it lacks.
 */
export function initStudio(root: string): string[] {
  const made: string[] = []
  const put = (relative: string, text: string) => {
    if (seed(join(root, relative), text)) made.push(relative)
  }
  put(
    'studio.config.json',
    JSON.stringify(
      {
        '//': 'The story model. openai-compatible reaches Ollama (http://127.0.0.1:11434/v1), LM Studio (http://127.0.0.1:1234/v1) or llama.cpp; claude-cli is the fallback and refuses explicit material.',
        model: { backend: 'claude-cli', url: 'http://127.0.0.1:11434/v1', model: 'claude-opus-5', api_key_env: 'STUDIO_MODEL_KEY', temperature: 0.9 },
        proposals: 5,
      },
      null,
      2,
    ) + '\n',
  )
  put('.gitignore', '# Rendered candidates are large and regenerable; approved and final panels are not.\ncomics/*/generations/\n')
  put(
    'README.md',
    `# comic-studio

The creative canon and the comics in development, as files. Tooling lives in
luma-vault (\`pnpm studio\`); nothing here depends on it to be read.

- \`characters/<id>/\` — one Markdown file per facet of a character, plus
  \`generation.yaml\` (how the image model draws her) and \`outfits/\`.
  Only \`approve\` writes into these; proposals sit in \`proposals/\`.
- \`world/\` — canon, timeline, rules shared by every comic.
- \`locations/\` — one Markdown file per place.
- \`comics/<id>/\` — concept, outline, story, continuity, \`scenes/*.yaml\`,
  \`panels/*.yaml\`, and later generations, approved and final.

Canon never changes silently. A proposal that contradicts it is flagged;
a person keeps the canon, changes the scene, or changes the canon on purpose.
`,
  )
  put('world/canon.md', stub('World canon', 'Facts every comic shares.'))
  put('world/timeline.md', stub('Timeline', 'What happened when, across comics.'))
  put('world/rules.md', stub('Rules', 'What is and is not possible in this world.'))
  put('locations/README.md', '# Locations\n\nOne file per place: `<id>.md` with what it looks like, what is in it, and what has happened there.\n')
  for (const dir of ['comics', 'prompts', 'workflows']) mkdirSync(join(root, dir), { recursive: true })
  return made
}

/** A character folder with every canon file present and empty. */
export function scaffoldCharacter(studio: Studio, id: string, name: string): string[] {
  assertId(id, 'character')
  const dir = characterDir(studio, id)
  const made: string[] = []
  const put = (file: string, text: string) => {
    if (seed(join(dir, file), text)) made.push(join('characters', id, file))
  }
  const hints: Record<CharacterFile, string> = {
    core: 'Who she is in three lines: name, age, what she does, what the comic needs her for.',
    appearance: 'Face, body, hair, the details a render must get right.',
    personality: 'Strengths, flaws, contradictions, how she behaves under stress, embarrassed, attracted, angry.',
    history: 'Origin, childhood, the experiences that made her.',
    interests: 'Hobbies, habits, what she reads, eats, avoids.',
    relationships: 'Who matters to her and how she behaves with each.',
    sexuality: 'Attraction, preferences, behaviour, what she wants and does not.',
    humor: 'What she finds funny, how she jokes, when she cannot.',
    speech: 'How she talks: rhythm, vocabulary, what she never says.',
    boundaries: 'What she will not do, and what this studio will not write about her.',
    outfits: 'Index of `outfits/*.yaml`, one per persistent outfit.',
    current_state: 'Where she is in her life right now, updated as comics happen.',
  }
  for (const file of CHARACTER_FILES) put(`${file}.md`, stub(`${name} — ${file.replace('_', ' ')}`, hints[file]))
  mkdirSync(join(dir, 'proposals'), { recursive: true })
  mkdirSync(join(dir, 'outfits'), { recursive: true })
  return made
}
