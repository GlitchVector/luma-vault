/**
 * What the model is told for each task. One file, so a change to how
 * proposals come out is a diff here and nowhere else. Every brief ends the
 * same way: propose, do not decide; the person approves.
 */

export const PROPOSALS_JSON_SCHEMA = (count: number): Record<string, unknown> => ({
  type: 'object',
  properties: {
    proposals: {
      type: 'array',
      minItems: 1,
      maxItems: count,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, text: { type: 'string' } },
        required: ['title', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['proposals'],
  additionalProperties: false,
})

export function characterBrief(character: string, count: number): string {
  return `You are helping a comic author develop a character called "${character}", collaboratively and one facet at a time. The context shows what is already canon about her and the world; treat it as fixed.

Propose ${count} distinct, specific possibilities for what the author asks about. Each proposal:
- is concrete enough to write a scene from (a behaviour, a habit, a memory, a line she would say), not a summary
- is consistent with the canon shown; if one would contradict it, say so inside the text and mark it "contradicts canon: …"
- differs from the others in kind, not only in degree
- stays in the register of the author's request

Do not write a biography. Do not decide anything: the author picks what becomes canon. "title" is a short label; "text" is one or two paragraphs.`
}

/**
 * The user turn for a facet's ask. Naming the facet is what keeps the model on
 * the question; the canon in context pulls hard toward what already exists.
 * For an explicit facet it also says what kind of book this is, so the model
 * does not answer a tamer neighbouring question instead.
 */
export function facetAsk(facet: string, hint: string, ask: string, explicit: boolean): string {
  const adult = explicit
    ? '\nThis is an adult comic and she is an adult. The facet is about sex: answer that question, frankly and explicitly, in her register — not a tamer question next to it.'
    : ''
  return `Facet being developed: ${facet} — ${hint}${adult}\n\nAsk: ${ask}`
}

export function storyBrief(comic: string, count: number): string {
  return `You are a creative collaborator on the comic "${comic}". The context shows the world, the cast's voices, and the story so far; treat all of it as fixed.

Propose ${count} distinct possibilities for what the author asks. Prefer small creative steps: the next two or three minutes of a scene, three directions a beat could take, five things this character would realistically do — never the whole story. Each proposal:
- is specific: who does what, what changes, what it costs
- is in character; flag anything that strains canon with "contradicts canon: …"
- avoids the predictable version unless asked for it
- differs from the others in kind

Do not write prose for the comic. Do not decide: the author chooses. "title" is a short label; "text" is one or two paragraphs.`
}

export const SCENE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    purpose: { type: 'string' },
    characters: { type: 'array', items: { type: 'string' } },
    location: { type: 'string' },
    start_state: { type: 'object', additionalProperties: { type: 'object', properties: { mood: { type: 'string' } }, additionalProperties: true } },
    beats: { type: 'array', items: { type: 'string' } },
    end_state: { type: 'object', additionalProperties: { type: 'object', properties: { mood: { type: 'string' } }, additionalProperties: true } },
    continuity_changes: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'purpose', 'characters', 'location', 'start_state', 'beats', 'end_state', 'continuity_changes'],
  additionalProperties: false,
}

export function sceneBrief(comic: string): string {
  return `You turn an approved story direction into one scene specification for the comic "${comic}". The context shows the world, the cast and the story so far; the direction is the author's and is fixed.

Fill the scene: purpose (what it must do for the story, one sentence), characters (ids from the context), location (an id-like short name), start_state and end_state (a mood per character), beats (4 to 8 short lines, each one thing that happens or changes, in order), continuity_changes (facts that are true afterwards and were not before — empty if none).

Beats are actions and reactions, not prose. No dialogue lines. Do not invent canon: a beat that would need a new fact about a character says "(needs canon: …)".`
}

export const PANELS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    panels: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          story_function: { type: 'string' },
          camera: {
            type: 'object',
            properties: { framing: { type: 'string' }, angle: { type: 'string' }, focal_feel: { type: 'string' } },
            required: ['framing', 'angle'],
            additionalProperties: false,
          },
          environment: { type: 'object', properties: { location: { type: 'string' }, lighting: { type: 'string' } }, required: ['location', 'lighting'], additionalProperties: false },
          characters: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                screen_position: { type: 'string' },
                pose: { type: 'string' },
                body_orientation: { type: 'string' },
                head_orientation: { type: 'string' },
                gaze_target: { type: 'string' },
                expression: { type: 'string' },
                outfit: { type: 'string' },
              },
              required: ['screen_position', 'pose', 'gaze_target', 'expression'],
              additionalProperties: false,
            },
          },
          beat: { type: 'string' },
        },
        required: ['story_function', 'camera', 'environment', 'characters', 'beat'],
        additionalProperties: false,
      },
    },
  },
  required: ['panels'],
  additionalProperties: false,
}

export function panelsBrief(count: number | undefined): string {
  return `You break a scene into panels for a comic. The context shows the scene, the characters' looks and outfits, the location, and any panels already made for this scene.

Produce ${count ? `exactly ${count}` : 'as many panels as the beats need, usually 4 to 8'}, in reading order. Each panel says what it must communicate (story_function, one sentence), which beat it covers, and how it is staged: camera framing (close-up / medium / wide / two-shot …) and angle (eye level / slight low / high …), the location and lighting, and for every character on screen her screen_position, pose, body_orientation, head_orientation, gaze_target, expression and outfit (an outfit id from the context, or "default").

Stage, do not draw: values are a director's short phrases, not image-model prompts. Vary framing across the sequence. Put nobody in a panel who is not in the scene. Do not write dialogue.`
}

export const CONTINUITY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          where: { type: 'string', description: 'the beat, field or line in the document' },
          canon: { type: 'string', description: 'the established fact, quoted or paraphrased, with its source' },
          conflict: { type: 'string', description: 'what the document says that conflicts' },
          severity: { type: 'string', enum: ['contradiction', 'strain', 'gap'] },
        },
        required: ['where', 'canon', 'conflict', 'severity'],
        additionalProperties: false,
      },
    },
  },
  required: ['warnings'],
  additionalProperties: false,
}

export const CONTINUITY_BRIEF = `You check a comic document (a scene or a panel) against established canon. The context shows the canon first and the document last.

List every place the document conflicts with canon: a contradiction (canon says one thing, the document another), a strain (out of character, or a stretch the canon does not support), or a gap (the document relies on a fact no canon establishes). Quote the canon you are relying on and name its source file.

Report only. Do not suggest rewrites, do not rank, do not praise. An empty list is a fine answer.`

export const CLICHE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { where: { type: 'string' }, kind: { type: 'string' }, why: { type: 'string' } },
        required: ['where', 'kind', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

export const CLICHE_BRIEF = `You are a critic reading a comic document (scene beats or a panel's dialogue) with the cast's voices in front of you.

Point at what is generic: AI-flavoured prose, stock erotic beats, predictable escalation, repeated jokes or emotional beats, exposition disguised as dialogue, characters agreeing too easily, a line anyone could say. For each: where, what kind, and why it reads that way.

Criticism only. Do not rewrite, do not soften, do not praise. The author decides what to change.`
