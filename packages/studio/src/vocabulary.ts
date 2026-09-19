/**
 * The words the checkpoint was actually trained on.
 *
 * A panel spec is written for a person: "hanging one-armed from the lowest
 * surviving rung, other hand reaching up, one knee drawn to brace on the
 * rail". Handed to a sampler, the only words it recognises are the
 * incidental ones — `knee` — so it drew her kneeling. The rule this module
 * exists to enforce is that only real tags reach a prompt, and prose stays
 * in the studio where a person reads it.
 *
 * The vocabulary is the tagger's own `selected_tags.csv`, the same list
 * `pnpm comic script` checks against and the same one every LoRA in this
 * house was captioned with, so "is this a tag" has one answer everywhere.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const DEFAULT_TAGS_CSV = join(REPO_ROOT, 'models', 'anime-tagger', 'selected_tags.csv')

export interface Vocabulary {
  has(phrase: string): boolean
  /** How many pictures carried the tag; a proxy for how strongly it pulls. */
  count(phrase: string): number
  readonly size: number
}

/** Words that are tags but say nothing about staging, so they only add noise. */
const IGNORED = new Set(['solo', '1girl', '1boy', '2girls', 'girl', 'boy', 'general', 'sensitive', 'questionable', 'explicit'])

export function loadVocabulary(csvPath = DEFAULT_TAGS_CSV): Vocabulary {
  const counts = new Map<string, number>()
  if (existsSync(csvPath)) {
    for (const line of readFileSync(csvPath, 'utf8').split('\n').slice(1)) {
      const parts = line.split(',')
      const name = parts[1]?.trim()
      if (!name) continue
      counts.set(name.replaceAll('_', ' ').toLowerCase(), Number(parts[3]) || 0)
    }
  }
  return {
    has: (phrase) => counts.has(phrase) && !IGNORED.has(phrase),
    count: (phrase) => counts.get(phrase) ?? 0,
    size: counts.size,
  }
}

/**
 * What a director calls a thing, and what the tagger calls it.
 *
 * Measured against `selected_tags.csv`, not guessed: `crouching` is not a
 * tag at all (danbooru says `squatting`, 70k pictures), so "crouching low"
 * used to lose its pose entirely and the panel came back standing.
 */
const SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcrouch(ing|ed|es)?\b/g, 'squatting'],
  [/\b(arms crossed|folded arms|arms folded)\b/g, 'crossed arms'],
  [/\breaching out\b/g, 'outstretched arm'],
  [/\b(back|turned) (three[- ]quarters? )?(to|toward|towards) (the )?camera\b/g, 'from behind'],
  [/\b(facing|to|toward|towards|at) (the )?camera\b/g, 'looking at viewer'],
  [/\bover (her|his|the) shoulder\b/g, 'looking back'],
  [/\bthree[- ]quarters?\b/g, ' '],
  [/\bhead (tilted|cocked)\b/g, 'head tilt'],
  [/\b(eyes closed|eyes shut)\b/g, 'closed eyes'],
  [/\b(mouth open|lips parted)\b/g, 'parted lips'],
]

/**
 * Real tags that mean the wrong thing when they turn up in staging prose.
 *
 * "back three-quarters to camera" means she faces away; as tags it became
 * `back, camera`, and the render grew a literal camera in her hands. These
 * are dropped from staging only — a scene may legitimately contain a
 * camera, and multi-word tags like `looking back` match before the bare
 * word ever gets a chance.
 */
const BLOCKED_IN_STAGING = new Set(['camera', 'back', 'drone', 'palms', 'hanging', 'light', 'shadow', 'leaning'])

function applySynonyms(text: string): string {
  let out = text.toLowerCase().replaceAll('_', ' ')
  for (const [pattern, replacement] of SYNONYMS) out = out.replace(pattern, replacement)
  return out
}

/** Longest run of words that is a tag, scanned left to right. Up to four
 *  words, because `hands on own cheeks` is a tag and five-word tags are not
 *  worth the passes. */
const MAX_WORDS = 4

/**
 * Every tag hiding in a piece of prose, in the order it appears.
 *
 * Longest match wins, so "looking at viewer" is one tag rather than
 * "looking" plus "viewer", and the words it consumed cannot match again.
 * A phrase with nothing recognisable contributes nothing at all — that is
 * the point, and it is why the caller must be willing to render a panel
 * from fewer words than the director wrote.
 */
export function tagsFrom(text: string | undefined, vocabulary: Vocabulary): string[] {
  if (!text) return []
  const found: string[] = []
  const seen = new Set<string>()
  for (const phrase of String(text).toLowerCase().replaceAll('_', ' ').split(/[,;.]/)) {
    const tokens = phrase.split(/[^a-z0-9'-]+/).filter(Boolean)
    let i = 0
    while (i < tokens.length) {
      let matched = 0
      for (let n = Math.min(MAX_WORDS, tokens.length - i); n >= 1; n--) {
        const candidate = tokens.slice(i, i + n).join(' ')
        if (vocabulary.has(candidate)) {
          if (!seen.has(candidate)) {
            seen.add(candidate)
            found.push(candidate)
          }
          matched = n
          break
        }
      }
      i += matched || 1
    }
  }
  return found
}

/**
 * The tags worth keeping from a director's staging line.
 *
 * Rare tags are dropped: a word the tagger saw a handful of times steers a
 * render about as reliably as a typo, and staging prose is full of them
 * ("rung", "coping"). The threshold is deliberately low — plenty of good
 * pose tags are in the low thousands — it only removes the long tail.
 */
export function stagingTags(text: string | undefined, vocabulary: Vocabulary, minimum = 500): string[] {
  if (!text) return []
  return tagsFrom(applySynonyms(text), vocabulary).filter(
    (tag) => vocabulary.count(tag) >= minimum && !BLOCKED_IN_STAGING.has(tag),
  )
}

/**
 * The same for a place. No staging blocklist: a scene may legitimately hold
 * a camera, and the floor is lower because the useful location words are
 * rarer than the useful pose words (`rooftop` 4k, `standing` 733k).
 */
export function sceneTags(text: string | undefined, vocabulary: Vocabulary, minimum = 400): string[] {
  if (!text) return []
  return tagsFrom(applySynonyms(text), vocabulary).filter((tag) => vocabulary.count(tag) >= minimum)
}
