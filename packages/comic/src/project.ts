/**
 * Where a comic's files live, and how its config is put together.
 *
 * A project is a folder. Every stage reads from and writes to fixed places in
 * it, so a stage can be rerun alone and `git status` on the folder shows what
 * changed. Paths given on the command line resolve against the directory
 * `pnpm comic` was typed in (`INIT_CWD`), not the package, which is where
 * pnpm actually runs the script.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configSchema, scriptSchema, type Config, type Script } from './schema.ts'

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..')
export const ASSETS_DIR = join(PACKAGE_DIR, 'assets')

export interface Project {
  dir: string
  name: string
  prosePath: string
  scriptPath: string
  panelsDir: string
  qaDir: string
  buildDir: string
  outDir: string
  config: Config
}

export function resolveUserPath(given: string): string {
  if (isAbsolute(given)) return given
  return resolve(process.env['INIT_CWD'] ?? process.cwd(), given)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`, { cause: error })
  }
}

/**
 * The package's config, with the project's laid over it one top-level key at
 * a time — except `characters`, which merge by id so a project can add one
 * character without restating the cast.
 */
export function loadConfig(projectDir: string): Config {
  const base = readJson(join(PACKAGE_DIR, 'comic.config.json')) as Record<string, unknown>
  const overridePath = join(projectDir, 'comic.config.json')
  let merged: Record<string, unknown> = { ...base }
  if (existsSync(overridePath)) {
    const override = readJson(overridePath) as Record<string, unknown>
    merged = { ...base, ...override }
    merged['characters'] = {
      ...((base['characters'] as Record<string, unknown> | undefined) ?? {}),
      ...((override['characters'] as Record<string, unknown> | undefined) ?? {}),
    }
    for (const key of ['forge', 'prompt', 'page', 'qa', 'writer'] as const) {
      if (base[key] && override[key] && typeof override[key] === 'object') {
        merged[key] = { ...(base[key] as object), ...(override[key] as object) }
      }
    }
  }
  const parsed = configSchema.safeParse(merged)
  if (!parsed.success) {
    throw new Error(`comic.config.json is not valid:\n${formatIssues(parsed.error.issues)}`)
  }
  return parsed.data
}

export function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('\n')
}

export function openProject(given: string): Project {
  const dir = resolveUserPath(given)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return {
    dir,
    name: dir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'comic',
    prosePath: join(dir, 'prose.md'),
    scriptPath: join(dir, 'script.json'),
    panelsDir: join(dir, 'panels'),
    qaDir: join(dir, 'qa'),
    buildDir: join(dir, 'build'),
    outDir: join(dir, 'out'),
    config: loadConfig(dir),
  }
}

export function loadScript(project: Project): Script {
  if (!existsSync(project.scriptPath)) {
    throw new Error(`${project.scriptPath} does not exist — run \`comic script\` first`)
  }
  const parsed = scriptSchema.safeParse(readJson(project.scriptPath))
  if (!parsed.success) {
    throw new Error(`${project.scriptPath} is not a valid script:\n${formatIssues(parsed.error.issues)}`)
  }
  return parsed.data
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/** Panel ids are `p<page>-<n>`, both 1-based, and a `--panel` may be either
 *  the id or the number within the page. */
export function panelId(pageNumber: number, panelNumber: number): string {
  return `p${pageNumber}-${panelNumber}`
}
