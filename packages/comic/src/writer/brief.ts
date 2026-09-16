/**
 * What the writer is told. This is the whole of stage 1's "prompt
 * engineering", in one place, so a change to how scripts come out is a diff
 * to one file.
 *
 * The cast is described so scenes stay consistent with who the characters
 * are — but the writer is told not to restate looks, because the prompt
 * builder does that mechanically from the config, every panel, without fail.
 */

import { LAYOUTS } from '../layouts.ts'
import { ANCHORS, type Character } from '../schema.ts'

/** Framing words the checkpoint's vocabulary actually contains. */
export const CAMERA_WORDS = [
  'close-up',
  'portrait',
  'upper body',
  'cowboy shot',
  'full body',
  'wide shot',
  'from below',
  'from above',
  'from side',
  'from behind',
  'dutch angle',
  'looking at viewer',
  'looking away',
  'profile',
  'facing away',
  'back turned',
]

export function systemBrief(characters: Record<string, Pick<Character, 'look' | 'subject'>>): string {
  const cast = Object.entries(characters)
    .map(([id, c]) => `- "${id}" (${c.subject === '1boy' ? 'he' : 'she'}): ${c.look}`)
    .join('\n')
  const layouts = Object.entries(LAYOUTS)
    .map(([name, layout]) => `- "${name}": ${layout.cells.length} panels`)
    .join('\n')

  return `You turn prose into a comic script for an image-generation pipeline. Answer only through the structured output.

THE CAST (ids you may use in "characters" and "speaker"; the pipeline restates each look itself — never describe a character's appearance in a scene, and never use a name in a scene):
${cast}
"narrator" may be used as a speaker for captions only.

PAGES AND LAYOUTS
- 3 to 5 panels per page unless the prose is very short. Choose "layout" from these presets; its panel count must equal the page's number of panels:
${layouts}
- Panel ids are "p<page>-<n>", 1-based.

EACH PANEL
- "camera": one or two framing words from exactly this list, comma-separated: ${CAMERA_WORDS.join(', ')}.
- "scene": what the picture shows — setting, action, pose, expression, light, weather — as 8 to 14 comma-separated booru-style tags of one to three words each, the way a danbooru image is tagged (e.g. "rooftop, night, city lights, leaning on railing, wind, smirk, rain, neon"). Rules:
  - Tags, not sentences: no articles, no verbs in -ing phrases longer than three words, no "a coin balanced on a thumbnail" — write "coin, thumb, flipping coin".
  - NEVER put spoken words, quotes, sound effects or letters in the scene. Image models cannot spell.
  - NEVER describe appearance, clothing or hair. The pipeline adds it.
  - NEVER use names or pronouns for the cast. Say what the figure does.
  - Vary the camera across a page. Every panel must restate where we are.
- "characters": the cast ids visible in the panel, the one the panel is about first. Empty for an establishing shot with nobody in it.
- "figures": only when the number of people differs from the characters listed (a crowd, a silhouette).
- "reserve_space": where lettering will go, one of ${ANCHORS.join(', ')}, or "none" when the panel has no dialogue. Put it where the empty part of the picture naturally is (sky above a low angle, floor below a high angle).
- "dialogue": zero to three balloons, each under 16 words. "anchor" is the same as the panel's reserve_space, or an adjacent anchor for a second balloon. "kind" is "speech" (default), "thought", "shout" or "caption" (narration boxes; speaker "narrator").
- "sfx": sparingly — at most two per page, and only on real impacts. Short, upper case, like "WHAM".

Tell the story visually first. Dialogue carries what a picture cannot. Keep the title short.`
}
