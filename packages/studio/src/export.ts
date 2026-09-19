/**
 * The bridge from the studio to the renderer: a comic project, generated.
 *
 * The studio owns what a panel means — story function, staging, who is in it,
 * what she wears, what she says. `@luma/comic` owns pixels. Neither imports
 * the other; this writes the one document they both understand, a
 * `script.json` plus the `comic.config.json` that names the LoRAs, and then
 * `pnpm comic panels <dir>` renders it like any other project.
 *
 * Nothing here decides anything creative. Every value traces to a file the
 * person approved: the panel spec, the character's `generation.yaml`, the
 * outfit's `prompt_words`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { COMIC_LAYOUTS } from '@luma/core'
import { characterDir, comicDir, writeText, type Studio } from './root.ts'
import { listIds, readComic, readPanel, type Panel } from './spec.ts'
import { loadVocabulary, sceneTags, stagingTags, type Vocabulary } from './vocabulary.ts'

/** How the image model draws a character. Lives in the studio so the panel
 *  specs never carry prompt syntax. */
export const generationSchema = z.object({
  model: z.string().default('delburry75'),
  lora: z.string(),
  lora_weight: z.number().default(1),
  trigger: z.string(),
  /** Identity words the LoRA does not carry on its own. */
  trait_words: z.string().default(''),
  subject: z.enum(['1girl', '1boy', '1other']).default('1girl'),
  lighting_default: z.string().default(''),
  /** Stable across every comic. Derived from the id when absent. */
  seed_family: z.number().int().min(0).optional(),
})
export type Generation = z.infer<typeof generationSchema>

export const outfitSchema = z.object({
  id: z.string().optional(),
  /** The words that put this outfit in a prompt. Everything else in the
   *  outfit file is for a person to read. */
  prompt_words: z.string().default(''),
  must_not_appear: z.array(z.string()).default([]),
})

function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'))
}

export function readGeneration(studio: Studio, id: string): Generation {
  const path = join(characterDir(studio, id), 'generation.yaml')
  if (!existsSync(path)) {
    throw new Error(`${id} has no generation.yaml — the renderer needs her LoRA, trigger and weight`)
  }
  const parsed = generationSchema.safeParse(readYaml(path))
  if (!parsed.success) {
    throw new Error(`${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  return parsed.data
}

export function readOutfit(studio: Studio, id: string, outfit: string): { words: string; avoid: string[] } {
  const path = join(characterDir(studio, id), 'outfits', `${outfit}.yaml`)
  if (!existsSync(path)) return { words: '', avoid: [] }
  const parsed = outfitSchema.safeParse(readYaml(path))
  if (!parsed.success) return { words: '', avoid: [] }
  return { words: parsed.data.prompt_words, avoid: parsed.data.must_not_appear }
}

/**
 * The place's id, out of whatever ended up in `environment.location`.
 *
 * The panel planner writes the id and then keeps describing: "rooftop — gravel
 * deck, squat vent housings, parapet edge". The id is the part before it
 * starts describing, so everything from the first dash or comma is dropped.
 */
export function locationId(raw: string | undefined): string {
  if (!raw) return ''
  return String(raw)
    .split(/[\u2014\u2013,;(]/)[0]!
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

/**
 * A location's prompt words, if someone has written them.
 *
 * `locations/<id>.md` is prose for a person. A line beginning
 * `prompt_words:` is the technical half, the same bargain outfits strike:
 * the description stays readable, and the renderer gets tags rather than a
 * sentence it will mostly ignore.
 */
export function readLocationWords(studio: Studio, id: string): string | null {
  const path = join(studio.root, 'locations', `${id}.md`)
  if (!existsSync(path)) return null
  const line = readFileSync(path, 'utf8').match(/^prompt_words:\s*(.+)$/m)
  return line ? line[1]!.trim() : null
}

/** A seed family from the character's id, so it is the same every run and on
 *  every machine without anyone having to pick a number. */
export function seedFamilyFor(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  // Room for 10 pages x 10 panels x 10 attempts above each family.
  return 10_000 + (Math.abs(hash) % 8000) * 1000
}

/**
 * A director writes "medium-wide, gravel field and vent housings filling the
 * right of frame"; a checkpoint understands `medium shot`. This is the
 * translation, and it is the whole reason the bridge exists: the studio
 * keeps the director's own words, the renderer gets tags.
 *
 * Longest phrase first, because "medium close-up" must not match as
 * "medium". Anything with no match contributes nothing rather than being
 * passed through as prose the sampler will ignore or, worse, latch onto.
 */
const FRAMING: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bextreme close[- ]?up\b/, 'close-up, face focus'],
  [/\bmedium close[- ]?up\b/, 'upper body'],
  [/\bclose[- ]?up\b/, 'close-up'],
  [/\b(establishing|extreme wide|very wide)\b/, 'wide shot, scenery'],
  [/\bmedium[- ]wide\b/, 'medium shot'],
  [/\btwo[- ]shot\b/, 'medium shot'],
  [/\bwide\b/, 'wide shot'],
  [/\b(full figure|full body|full[- ]length)\b/, 'full body'],
  [/\bcowboy\b/, 'cowboy shot'],
  [/\b(upper body|waist up|bust)\b/, 'upper body'],
  [/\bmedium\b/, 'medium shot'],
  [/\bportrait\b/, 'portrait'],
]

const ANGLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bover (her|his|the) shoulder\b/, 'from behind, over the shoulder'],
  [/\b(from behind|behind her|back view)\b/, 'from behind'],
  [/\b(worm|ground level|very low)\b/, 'from below'],
  [/\b(bird|overhead|top down|looking down|high angle|from above)\b/, 'from above'],
  [/\b(low angle|slight low|from below|looking up|\blow\b)\b/, 'from below'],
  [/\bdutch\b/, 'dutch angle'],
  [/\b(profile|from side|side on)\b/, 'from side'],
  [/\beye level\b/, ''],
]

/** Every tag a rule matches, in the order the rules are written. */
function translate(text: string | undefined, table: ReadonlyArray<readonly [RegExp, string]>): string[] {
  if (!text) return []
  const source = String(text).toLowerCase().replaceAll('_', ' ')
  const found: string[] = []
  let left = source
  for (const [pattern, tag] of table) {
    if (!pattern.test(left)) continue
    // Consume the match so a later, looser rule cannot fire on the same words.
    left = left.replace(pattern, ' ')
    if (tag) found.push(tag)
  }
  return found
}

/**
 * The camera as tags. Framing first, then angle, which is the order the
 * checkpoint's training captions use.
 */
export function cameraWords(framing: string | undefined, angle: string | undefined): string {
  // Both fields through both tables: a director writes "medium close-up over
  // her shoulder" in the framing and "eye level with her hands" in the angle,
  // so neither field reliably holds only its own kind of word.
  const both = [framing, angle].filter(Boolean).join(', ')
  const tags = [...translate(both, FRAMING), ...translate(both, ANGLE)]
  return words(...tags) || 'medium shot'
}

/** Director's words to prompt words: underscores out, duplicates gone. */
function words(...parts: Array<string | undefined>): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    if (!part) continue
    for (const raw of String(part).split(',')) {
      const word = raw.trim().replaceAll('_', ' ').toLowerCase()
      if (!word || seen.has(word)) continue
      seen.add(word)
      out.push(word)
    }
  }
  return out.join(', ')
}

/**
 * Where a balloon sits, from where its speaker was staged. A panel spec says
 * `screen_position: left_foreground`, so the balloon goes above her on that
 * side and its tail points back down at her, rather than at the middle of
 * the frame like the default.
 */
export function anchorFor(position: string | undefined, index: number): { anchor: string; tail: { x: number; y: number } } {
  const side = (position ?? '').toLowerCase()
  const left = side.includes('left')
  const right = side.includes('right')
  const x = left ? 26 : right ? 74 : 50
  // Second and later balloons in a panel move to the other side so they do
  // not stack on the same corner.
  const flip = index % 2 === 1
  const anchor = left === right ? (flip ? 'bottom' : 'top') : (left ? (flip ? 'bottom-left' : 'top-left') : flip ? 'bottom-right' : 'top-right')
  return { anchor, tail: { x, y: side.includes('background') ? 45 : 58 } }
}

/**
 * A gaze is only a tag when it points out of the frame. "looking at maya"
 * is a fact about the staging that the sampler has no word for; `looking at
 * viewer` is one of the strongest tags there is, so it is worth getting
 * right and worth never emitting by accident.
 */
export function gazeTags(target: string | undefined): string[] {
  if (!target) return []
  const at = target.toLowerCase()
  if (/\b(viewer|camera|reader|us)\b/.test(at)) return ['looking at viewer']
  if (/\b(away|offscreen|off-screen|distance|horizon|sky)\b/.test(at)) return ['looking away']
  return []
}

/** The preset for a page of `count` panels. */
export function layoutFor(count: number): string {
  const byCount: Record<number, string> = { 1: 'splash', 2: 'two-stack', 3: 'hero-top', 4: 'grid-2x2', 5: 'wide-2-2', 6: 'grid-2x3' }
  const name = byCount[count]
  if (!name || !COMIC_LAYOUTS[name]) throw new Error(`no layout for ${count} panels a page`)
  return name
}

export interface ExportOptions {
  /** Most panels on one page before it is split. */
  perPage?: number
  /** The tag list to filter prose against. Loaded from the repo by default. */
  vocabulary?: Vocabulary
  /** Only these scenes, in this order. Default: every scene, in order. */
  scenes?: string[]
}

export interface Exported {
  dir: string
  pages: number
  panels: number
  characters: string[]
  /** Panels left out because they are not staged yet, with the reason. */
  skipped: Array<{ id: string; why: string }>
  /** Locations with no `prompt_words:` line, so their scene was guessed at
   *  by pulling tags out of the prose. Worth writing properly. */
  vagueLocations: string[]
}

/**
 * Write a comic project from a studio comic.
 *
 * Panels are grouped by the scene they belong to, because a scene is the unit
 * a person thinks in; a scene longer than `perPage` is split across pages
 * rather than crammed into a layout that does not exist.
 */
export function exportComic(studio: Studio, comicId: string, outDir: string, options: ExportOptions = {}): Exported {
  const comic = readComic(studio, comicId)
  const perPage = options.perPage ?? 4
  const sceneIds = options.scenes ?? listIds(studio, comicId, 'scenes')

  const vocabulary: Vocabulary = options.vocabulary ?? loadVocabulary()
  const vagueLocations: string[] = []

  const byScene = new Map<string, Panel[]>()
  const loose: Panel[] = []
  const skipped: Array<{ id: string; why: string }> = []
  for (const id of listIds(studio, comicId, 'panels')) {
    const panel = readPanel(studio, comicId, id)
    // A panel nobody has staged would render as whatever the checkpoint
    // felt like. Say so and leave it out rather than making something up.
    if (!panel.story_function && Object.keys(panel.characters).length === 0 && !panel.environment.location) {
      skipped.push({ id, why: 'nothing staged yet (no characters, no location, no story function)' })
      continue
    }
    if (panel.scene && byScene.has(panel.scene)) byScene.get(panel.scene)!.push(panel)
    else if (panel.scene) byScene.set(panel.scene, [panel])
    else loose.push(panel)
  }

  const groups: Panel[][] = []
  for (const sceneId of [...sceneIds, '']) {
    const panels = sceneId ? (byScene.get(sceneId) ?? []) : loose
    for (let i = 0; i < panels.length; i += perPage) groups.push(panels.slice(i, i + perPage))
  }
  if (groups.length === 0) throw new Error(`${comicId} has no staged panels to render — plan some first`)

  const used = new Set<string>()
  const pages = groups.map((panels) => ({
    layout: layoutFor(panels.length),
    panels: panels.map((panel) => {
      const cast = Object.entries(panel.characters)
      for (const [who] of cast) used.add(who)

      // Outfit words go in the scene, not in the character's `look`: `look`
      // is one string for the whole script, and she changes clothes. They
      // are used verbatim because a person curated them as tags already.
      const staging = cast.flatMap(([who, staged]) => {
        const outfit = staged.outfit && staged.outfit !== 'default' ? readOutfit(studio, who, staged.outfit).words : readOutfit(studio, who, 'default').words
        // `tags` is what the planner wrote as tags; everything else is the
        // director's prose and only its recognisable words get through.
        const explicit = typeof staged['tags'] === 'string' ? (staged['tags'] as string) : ''
        return [
          outfit,
          explicit,
          ...stagingTags([staged.pose, staged.body_orientation, staged.head_orientation, staged.expression].filter(Boolean).join(', '), vocabulary),
          ...gazeTags(staged.gaze_target),
        ]
      })

      // A place contributes its curated words or nothing at all. Scraping
      // tags out of its description looked helpful and was not: "old radio
      // building roof, alley below" yielded `radio, fire, alley`, which is a
      // burning radio rather than a rooftop. Same rule as the camera and the
      // staging — only words someone chose on purpose reach the sampler.
      const place = locationId(panel.environment.location as string | undefined)
      const curated = place ? readLocationWords(studio, place) : null
      if (place && !curated && !vagueLocations.includes(place)) vagueLocations.push(place)
      const lighting = sceneTags(panel.environment.lighting as string | undefined, vocabulary)

      const scene = words(...(curated ? [curated] : []), ...lighting, ...staging)
      const camera = cameraWords(panel.camera.framing as string | undefined, panel.camera.angle as string | undefined)

      const lines = panel.dialogue.lines.map((line, index) => {
        const speaker = cast.find(([who]) => who === line.speaker)
        const { anchor, tail } = anchorFor(speaker?.[1]?.screen_position, index)
        return {
          speaker: line.speaker,
          text: line.text,
          anchor,
          kind: line.bubble_type === 'thought' || line.bubble_type === 'shout' || line.bubble_type === 'caption' ? line.bubble_type : 'speech',
          tail_to: tail,
        }
      })

      return {
        id: panel.id,
        camera,
        scene: scene || 'a quiet moment',
        characters: cast.map(([who]) => who),
        pose: [],
        reserve_space: lines[0]?.anchor ?? 'none',
        dialogue: lines,
        sfx: [],
      }
    }),
  }))

  const characters: Record<string, unknown> = {}
  let checkpoint = ''
  for (const id of used) {
    const gen = readGeneration(studio, id)
    if (!checkpoint) checkpoint = gen.model
    characters[id] = {
      lora: `${gen.lora}:${gen.lora_weight}`,
      trigger: gen.trigger,
      look: words(gen.trait_words),
      subject: gen.subject,
      seed_family: gen.seed_family ?? seedFamilyFor(id),
    }
  }

  const script = {
    title: comic.title || comicId,
    characters: Object.fromEntries([...used].map((id) => [id, characters[id]])),
    locations: {},
    pages,
  }

  writeText(join(outDir, 'script.json'), JSON.stringify(script, null, 2) + '\n')
  writeText(
    join(outDir, 'comic.config.json'),
    JSON.stringify(
      {
        '//': `Generated by \`studio export ${comicId}\`. Edit the studio's panel specs and export again; hand edits here are overwritten.`,
        forge: checkpoint ? { checkpoint } : undefined,
        characters: script.characters,
      },
      null,
      2,
    ) + '\n',
  )
  writeText(
    join(outDir, 'prose.md'),
    `# ${script.title}\n\nGenerated from the studio comic \`${comicId}\`. The story lives there, not here:\nrunning \`comic script\` on this folder would overwrite the exported script.\n`,
  )

  return {
    dir: outDir,
    pages: pages.length,
    panels: pages.reduce((n, page) => n + page.panels.length, 0),
    characters: [...used],
    skipped,
    vagueLocations,
  }
}

export function defaultExportDir(studio: Studio, comicId: string): string {
  return join(comicDir(studio, comicId), 'render')
}
