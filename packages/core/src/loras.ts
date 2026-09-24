/**
 * The custom LoRA catalogue: the ones trained in this project, not the ones downloaded.
 *
 * Two statuses, the owner's own split (2026-09-21): **final** is a LoRA that passed the acceptance
 * test — the trigger ALONE renders the character on both checkpoints, verified by a check sheet, and
 * he said so — and **wip** is everything else we trained, including every superseded version. The
 * folders under `models/Lora/` mirror it (`final/`, `wip/`, `external/`); Forge resolves a LoRA by
 * its filename, so moving one between folders never changes a prompt.
 *
 * `docs/loras.md` stays the long-form record: what each training run measured, what failed, what the
 * verdict was. This file is only what a person needs to pick one from a list, and it is what the
 * Loras panel reads. When a LoRA is promoted, both change together.
 */

import { z } from 'zod'

export const loraStatusSchema = z.enum(['final', 'wip'])
export type LoraStatus = z.infer<typeof loraStatusSchema>

export const loraKindSchema = z.enum(['full', 'body', 'face', 'outfit'])
export type LoraKind = z.infer<typeof loraKindSchema>

export const loraEntrySchema = z.object({
  /** The filename without extension, which is also what `<lora:NAME:weight>` takes. */
  name: z.string(),
  /** The word the prompt must carry for the LoRA to bind. */
  trigger: z.string(),
  /** Who it is. Several entries can share a character — an outfit or a face LoRA of the same person. */
  character: z.string(),
  /** `full` is face, body and outfit together; `body` and `face` are halves; `outfit` is a variant wardrobe. */
  kind: loraKindSchema,
  /** One or two sentences: what she looks like, enough to pick her out of a list. */
  description: z.string(),
  status: loraStatusSchema,
  /** The weight that renders her correctly, where it is known. */
  weight: z.number().nullable().default(null),
  /** Superseded versions of the same thing, newest first. Kept installed, never the one to reach for. */
  olderVersions: z.array(z.string()).default([]),
  /** A line of context for the card: why it is where it is. */
  note: z.string().nullable().default(null),
  /**
   * The folder under `D:\AI\lora-train\datasets\` the installed file trained on. The LoRAs page reads
   * its `.toml` and shows every image the trainer saw (`lora_dataset`). Null when the data is not on
   * this machine.
   */
  dataset: z.string().nullable().default(null),
  /**
   * For a `kind: 'outfit'` entry: what the outfit is, in the owner's words (`winter`, `plate armour`).
   * The page lists it under the character's card instead of giving it a card of its own.
   */
  outfit: z.string().nullable().default(null),
  /**
   * The LoRA this one is a variant of - the name of a `full` entry. A variant lists under its
   * parent's card; an entry without a parent is a card of its own, whatever its kind. A new line of
   * the same character (`ari_gen` beside `ari_adopt`) is a new LoRA as far as LoRAs go, so it has no
   * parent and gets its own card (owner, 2026-09-21).
   */
  parent: z.string().nullable().default(null),
})
export type LoraEntry = z.infer<typeof loraEntrySchema>

/**
 * One entry per character or purpose, naming the version to reach for. Superseded versions ride along
 * in `olderVersions` rather than as entries of their own, so the list reads as a cast rather than a
 * changelog.
 */
export const CUSTOM_LORAS: readonly LoraEntry[] = [
  {
    name: 'ari_adopt_v4',
    dataset: 'ari-adopt',
    outfit: null,
    parent: null,
    trigger: 'ari',
    character: 'Ari',
    kind: 'full',
    description:
      'White chin-length bob fading to aqua under a teal headband, blue teardrop earrings, a gold chain with a round blue gem, a cropped teal top with a black collar and yoke, white high-waisted shorts and white platform sneakers.',
    status: 'final',
    weight: 1.2,
    olderVersions: ['ari_adopt_v1', 'ari_v1'],
    note: 'The recipe pilot: trigger-only captions, rank 64, 40 epochs. Renders the whole outfit from `ari` alone on both checkpoints; undressed states want the bottom named and the censor words negated.',
  },
  {
    name: 'ari_gen_v5',
    dataset: 'ari-gen-v5',
    outfit: null,
    parent: null,
    trigger: 'ari',
    character: 'Ari',
    kind: 'full',
    description:
      'Ari again, from the reference set generated off her own character sheet: the same white-to-aqua bob, teal top with the black yoke, white shorts and platform sneakers, on ten different backgrounds - 58 views since 2026-09-23, every framing native.',
    status: 'wip',
    weight: 1.2,
    olderVersions: ['ari_gen_v4', 'ari_gen_v3', 'ari_gen_v2', 'ari_gen_v1', 'ari_gen_s1'],
    note: 'v5 is v4 with `white shorts` on the six shorts close-up captions: v4 fixed the top at every scale (58/60) but reopened the shorts (11/24 per epoch), and that word closed the same fault on the topless frames in v3. Best file so far: v4 final on delburry75 at 1.2 (8/8).',
  },
  {
    name: 'ari_gen_space_leotard_s1',
    dataset: 'ari-space-leotard',
    outfit: 'Space-leotard',
    parent: 'ari_gen_v5',
    trigger: 'arispaceleotard',
    character: 'Ari',
    kind: 'outfit',
    description:
      'Ari in the retro-futuristic space leotard from her second sheet (2026-09-23): white vinyl one-piece with light-blue piping and a centre zip, ring collar, open sides and a crossed harness back, rocket badge on her left breast, opera gloves, one O-ring strap on her right thigh, white knee boots with a front stripe, silver discs over the ears; small drop earrings as in the sheet; no headband or necklace with this outfit.',
    status: 'wip',
    weight: null,
    olderVersions: [],
    note: 'First outfit variant built through the reference pipeline in sheet mode (the gate refused single figures of this sheet). Dataset rebuilt 2026-09-24 without body-frame cuts: 24 body, 21 native cowboys, 24 native uppers, 13 face, 9 details + 4 mirrors; nothing with the badge or the strap mirrored. Stage 1 not yet trained.',
  },
  {
    name: 'ari_gen_space_dress_s1',
    dataset: 'ari-space-dress',
    outfit: 'Space-dress',
    parent: 'ari_gen_v5',
    trigger: 'arispacedress',
    character: 'Ari',
    kind: 'outfit',
    description:
      'Ari in the retro-futuristic space dress from her third sheet (2026-09-23): glossy white vinyl mini-dress with a centre zip between red stripes, dark ring collar with red piping, rocket badge on her left breast, hip belt with an O-ring at each hip, opera gloves with red-edged arm bands, a small white hard-shell backpack high on the back, white knee boots with a front stripe, ear discs; her white bob fades to coral-red tips with this outfit; no headband, earrings or necklace.',
    status: 'wip',
    weight: null,
    olderVersions: [],
    note: 'Second outfit variant through the reference pipeline; every body and cowboy view passed in sheet mode at the first attempt. The pack was the one thing the generator fought: three rounds of front poses drew it at the hip or beside the shoulder until the text made it hidden in front views. Dataset rebuilt 2026-09-24 without body-frame cuts: 28 body, 26 native cowboys, 24 native uppers (22 poses per rung), 13 face, 8 details + 4 mirrors; nothing with the badge mirrored. Stage 1 not yet trained.',
  },
  {
    name: 'celoracle_v3',
    dataset: 'oracle',
    outfit: null,
    parent: null,
    trigger: 'celoracle',
    character: 'Celestial Oracle',
    kind: 'full',
    description:
      'Lavender thigh-length hair, a veil, a naked tabard over a loincloth, and a sun symbol at the chest.',
    status: 'wip',
    weight: null,
    olderVersions: ['celoracle_v2', 'celoracle_v1'],
    note: 'Pairs with `celoback_v1` for the rear. Needs NoobAI composing under a delburry75 refiner to lose the belt.',
  },
  {
    name: 'celoback_v1',
    outfit: 'rear (tabard back)',
    parent: 'celoracle_v3',
    dataset: 'oracle-back',
    trigger: 'celoback',
    character: 'Celestial Oracle',
    kind: 'outfit',
    description: 'The Oracle from behind: the tabard’s open back and the fall of the veil.',
    status: 'wip',
    weight: null,
    olderVersions: [],
    note: 'Rear companion to `celoracle_v3`.',
  },
  {
    name: 'lcroft_v2',
    dataset: 'lara',
    outfit: null,
    parent: null,
    trigger: 'lcroft',
    character: 'Lara Croft',
    kind: 'full',
    description: 'The classic look: teal tank, shorts, twin holsters, backpack and a ponytail.',
    status: 'wip',
    weight: null,
    olderVersions: ['lcroft_v3', 'lcroft_v1'],
    note: 'The only character here who is not the owner’s own. `lcroft_v3` folded the face sheets in and was not an improvement.',
  },
  {
    name: 'lcface_v7',
    dataset: 'lara-face',
    outfit: null,
    parent: 'lcroft_v2',
    trigger: 'lcface',
    character: 'Lara Croft',
    kind: 'face',
    description: 'Lara’s face alone, trained from two face sheets on realismIllustrious.',
    status: 'wip',
    weight: 0.8,
    olderVersions: ['lcface_v6', 'lcface_v5', 'lcface_v4', 'lcface_v3', 'lcface_v2', 'lcface_v1'],
    note: 'The face the owner wants on the Mira bodies: this pair at 0.6 and 0.8 in the face pass, on delburry75.',
  },
  {
    name: 'mirasolen_v2',
    dataset: 'mira',
    outfit: null,
    parent: null,
    trigger: 'mirasolen',
    character: 'Mira Solen',
    kind: 'full',
    description:
      'Pink zip crop top, a harness with holsters, striped shorts and mid-calf lace-up platform boots.',
    status: 'wip',
    weight: null,
    olderVersions: ['mirasolen_v1'],
    note: 'The boots sheet.',
  },
  {
    name: 'msolen_v2',
    outfit: 'sneakers',
    parent: 'mirasolen_v2',
    dataset: 'mira2',
    trigger: 'msolen',
    character: 'Mira Solen',
    kind: 'outfit',
    description: 'The sneakers sheets, with the twintails and the cap-and-ponytail variants as prompt switches.',
    status: 'wip',
    weight: null,
    olderVersions: ['msolen_v1'],
    note: null,
  },
  {
    name: 'msbody_v4',
    dataset: 'mira2-body',
    outfit: null,
    parent: 'mirasolen_v2',
    trigger: 'msbody',
    character: 'Mira Solen',
    kind: 'body',
    description: 'Mira’s body and wardrobe from the sneakers sheets, trained with the face masked out.',
    status: 'wip',
    weight: null,
    olderVersions: ['msbody_v3', 'msbody_v2', 'msbody_v1'],
    note: 'Meant to carry a face LoRA on top — the Lara pair is what the owner picked.',
  },
  {
    name: 'msface_v1',
    dataset: 'mira2-face',
    outfit: null,
    parent: 'mirasolen_v2',
    trigger: 'msface',
    character: 'Mira Solen',
    kind: 'face',
    description: 'Mira’s own face from the sheet’s portrait panel.',
    status: 'wip',
    weight: null,
    olderVersions: [],
    note: 'Usable, but the owner preferred the Lara face pair on her bodies.',
  },
  {
    name: 'msw_v4',
    outfit: 'white',
    parent: 'mirasolen_v2',
    dataset: 'mira3-body',
    trigger: 'msw',
    character: 'Mira Solen',
    kind: 'outfit',
    description:
      'White variant: a white ribbed halter crop top with black trim and a front zip, a harness without the cross strap, striped shorts.',
    status: 'wip',
    weight: null,
    olderVersions: ['msw_v5', 'msw_v3', 'msw_v2'],
    note: null,
  },
  {
    name: 'msp_v1',
    outfit: 'boots',
    parent: 'mirasolen_v2',
    dataset: 'mira4-body',
    trigger: 'msp',
    character: 'Mira Solen',
    kind: 'outfit',
    description:
      'Boots variant: pink cap and ponytail, a pink mock-neck top, brown striped micro shorts and three-buckle platform boots.',
    status: 'wip',
    weight: null,
    olderVersions: [],
    note: null,
  },
  {
    name: 'msd_v2',
    outfit: 'desert A',
    parent: 'mirasolen_v2',
    dataset: 'mira5-body',
    trigger: 'msd',
    character: 'Mira Solen',
    kind: 'outfit',
    description:
      'Desert A: a grey ribbed cut-out leotard, a hooded cowl scarf, a brown O-ring harness, arm and leg wraps and grey micro shorts.',
    status: 'wip',
    weight: null,
    olderVersions: ['msd_v1'],
    note: null,
  },
  {
    name: 'msdb_v2',
    outfit: 'desert B',
    parent: 'mirasolen_v2',
    dataset: 'mira5b-body',
    trigger: 'msdb',
    character: 'Mira Solen',
    kind: 'outfit',
    description: 'Desert B: desert A without the shorts, the high-leg thong-back leotard carrying the belt and thigh pouch.',
    status: 'wip',
    weight: null,
    olderVersions: ['msdb_v1'],
    note: null,
  },
  {
    name: 'msbs_v4',
    outfit: 'base sheet',
    parent: 'mirasolen_v2',
    dataset: 'mira6-body',
    trigger: 'msbs',
    character: 'Mira Solen',
    kind: 'outfit',
    description:
      'Base sheet: a black SOLEN crop tee over a navy high-leg bodysuit, chunky two-tone sneakers, twintails.',
    status: 'wip',
    weight: null,
    olderVersions: ['msbs_v3', 'msbs_v2e6', 'msbs_v1'],
    note: null,
  },
  {
    name: 'mswt_v2',
    outfit: 'winter',
    parent: 'mirasolen_v2',
    dataset: 'mira7-winter',
    trigger: 'mswt',
    character: 'Mira Solen',
    kind: 'outfit',
    description:
      'Winter: a cream ribbed hooded sweater dress with a fleece hood and hem, a brown raglan yoke with an emblem, a half-zip and chunky boots.',
    status: 'wip',
    weight: null,
    olderVersions: ['mswt_v1'],
    note: null,
  },
  {
    name: 'msar_v1',
    outfit: 'plate armour',
    parent: 'mirasolen_v2',
    dataset: 'mira8-armor',
    trigger: 'msar',
    character: 'Mira Solen',
    kind: 'outfit',
    description: 'Plate armour: ornate silver plate with gold trim and glowing blue cross emblems.',
    status: 'wip',
    weight: null,
    olderVersions: ['msar_v2'],
    note: null,
  },
  {
    name: 'kvoss_v2',
    dataset: 'kvoss',
    outfit: null,
    parent: null,
    trigger: 'kvoss',
    character: 'Kira Voss',
    kind: 'full',
    description:
      'Pink high ponytail, a black cropped hoodie with underboob and a back print, a black thong and black platform boots.',
    status: 'wip',
    weight: null,
    olderVersions: ['kvoss_v1'],
    note: null,
  },
  {
    name: 'embk_v2',
    dataset: 'embk',
    outfit: null,
    parent: null,
    trigger: 'embk',
    character: 'Ember Kael',
    kind: 'full',
    description:
      'Pyra-inspired: copper hair with a blonde streak, a teal armoured bodysuit and a single pauldron on her left shoulder.',
    status: 'wip',
    weight: null,
    olderVersions: ['embk_v1'],
    note: null,
  },
  {
    name: 'sevenc_v2',
    dataset: 'sevenc',
    outfit: null,
    parent: null,
    trigger: 'sevenc',
    character: '7C',
    kind: 'full',
    description:
      'Infiltration android: white short messy hair, orange eyes, a black bodysuit with glowing seams, white armour and a mechanical left arm.',
    status: 'wip',
    weight: null,
    olderVersions: ['sevenc_v1'],
    note: 'Her sheet says Mira Axiom; the owner calls her 7C.',
  },
  {
    name: 'sevencb_v1',
    outfit: 'leotard',
    parent: 'sevenc_v2',
    dataset: 'sevencb',
    trigger: 'sevencb',
    character: '7C',
    kind: 'outfit',
    description:
      'Leotard outfit: a black high-leg turtleneck leotard with side cut-outs and straps, a thigh strap and pouch.',
    status: 'wip',
    weight: null,
    olderVersions: ['sevencb_v2'],
    note: null,
  },
  {
    name: 'sevencc_v1',
    outfit: 'leather jacket',
    parent: 'sevenc_v2',
    dataset: 'sevencc',
    trigger: 'sevencc',
    character: '7C',
    kind: 'outfit',
    description: 'Third outfit: an open cropped leather jacket with an emblem over a bodysuit.',
    status: 'wip',
    weight: null,
    olderVersions: ['sevencc_v2'],
    note: 'The sheet named her Kaia; trained as 7C’s wardrobe.',
  },
  {
    name: 'sthorne_v1',
    dataset: 'sthorne',
    outfit: null,
    parent: null,
    trigger: 'sthorne',
    character: 'Sable Thorne',
    kind: 'full',
    description:
      'Dark-elf knight: long black hair with a green underlayer, green eyes, black lips, black spiked plate and a greatsword.',
    status: 'wip',
    weight: null,
    olderVersions: ['sthorne_v2'],
    note: null,
  },
  {
    name: 'lvane_v2',
    dataset: 'lvane',
    outfit: null,
    parent: null,
    trigger: 'lvane',
    character: 'Lyra Vane',
    kind: 'full',
    description:
      'Android: a silver high ponytail with bangs over one eye, blue eyes, a white glossy leotard with blue-lit joints, thigh boots and a hex core on her back.',
    status: 'wip',
    weight: 1.0,
    olderVersions: ['lvane_v1'],
    note: 'Her nude frames keep the android glow in every prompt variant; she needs undressed training data.',
  },
  {
    name: 'rati_v2',
    dataset: 'rati',
    outfit: null,
    parent: null,
    trigger: 'rati',
    character: 'Rati',
    kind: 'full',
    description:
      'Egyptian-themed: dark wavy hair, tan skin, a red halter dress over a pelvic curtain, a gold collar, belt, bracers and gladiator heels.',
    status: 'wip',
    weight: 1.0,
    olderVersions: ['zkemet_v1'],
    note: 'Never negate `pale skin` or `colored skin` on her line — both paint her face.',
  },
  {
    name: 'ratib_v1',
    outfit: 'variant B (temple)',
    parent: 'rati_v2',
    dataset: 'ratib',
    trigger: 'ratib',
    character: 'Rati',
    kind: 'outfit',
    description: 'Variant B: the same character in a temple-goddess wardrobe.',
    status: 'wip',
    weight: null,
    olderVersions: ['ratib_v3', 'ratib_v2'],
    note: null,
  },
]

/** The catalogue split the way the panel shows it, newest-looking first within each half. */
export function lorasByStatus(entries: readonly LoraEntry[] = CUSTOM_LORAS): Record<LoraStatus, LoraEntry[]> {
  return {
    final: entries.filter((entry) => entry.status === 'final'),
    wip: entries.filter((entry) => entry.status === 'wip'),
  }
}

/**
 * The search term that finds a LoRA's own renders in the library.
 *
 * Forge writes the whole positive prompt into the file's parameters, so the literal `<lora:name:`
 * appears in every render that used it and in no other. The trailing colon matters: without it
 * `ari_adopt_v1` would also match `ari_adopt_v1b`.
 */
export function loraRenderSearch(name: string): string {
  return `<lora:${name}:`
}

/**
 * The three renders a card shows, by what they are of, not merely by score.
 *
 * The owner's ask (2026-09-21): her mostly clothed, as a cowboy shot from the front and one from
 * behind, and one nude from behind. The library cannot answer that in a query - its tags are the
 * classifier's, not the prompt's words, and the search has no negation - so the card fetches her
 * starred renders and reads each prompt here. Every slot has a looser fallback so a character with
 * few starred renders still shows something; a slot still empty after that takes a RANDOM starred
 * render (his words), and the panel tops up from unstarred renders when even those run out.
 */
const COWBOY = /\bcowboy shot\b/i
const BEHIND = /\b(from behind|from the back|back view|looking back)\b/i
// `undress\w*` and the clothes-pull words catch a photostory's act stages: she is dressed there in
// the sense that the top exists, not in the sense the owner meant by "clothed mostly".
const UNDRESSED =
  /\b(nude|naked|topless|breasts out|nipples|bottomless|no panties|undress\w*|shirt lift|clothes pull|open clothes|unbuttoned|panties|underwear|bra)\b/i

const SHOWCASE_SLOTS: ReadonlyArray<ReadonlyArray<(prompt: string) => boolean>> = [
  [(p) => COWBOY.test(p) && !BEHIND.test(p) && !UNDRESSED.test(p), (p) => !BEHIND.test(p) && !UNDRESSED.test(p)],
  [(p) => COWBOY.test(p) && BEHIND.test(p) && !UNDRESSED.test(p), (p) => BEHIND.test(p) && !UNDRESSED.test(p)],
  [(p) => UNDRESSED.test(p) && BEHIND.test(p), (p) => UNDRESSED.test(p)],
]

export const SHOWCASE_SIZE = SHOWCASE_SLOTS.length

/**
 * `items` in the order the library ranked them; the first match wins each slot. `random` is
 * `Math.random` in the app and a fixed function in tests.
 */
export function pickShowcase<T>(
  items: readonly T[],
  promptOf: (item: T) => string | null | undefined,
  random: () => number = Math.random,
): T[] {
  const taken = new Set<T>()
  const picked: T[] = []
  for (const rules of SHOWCASE_SLOTS) {
    for (const rule of rules) {
      const hit = items.find((item) => !taken.has(item) && rule(promptOf(item) ?? ''))
      if (hit !== undefined) {
        taken.add(hit)
        picked.push(hit)
        break
      }
    }
  }
  return fillShowcase(picked, items, (item) => item, random)
}

/**
 * Top `picked` up to the showcase size with random members of `pool` it does not already hold.
 * `keyOf` says when two items are the same render (the panel compares by id, since the starred and
 * the unstarred query return distinct objects for one row).
 */
export function fillShowcase<T>(
  picked: readonly T[],
  pool: readonly T[],
  keyOf: (item: T) => unknown,
  random: () => number = Math.random,
): T[] {
  const out = [...picked]
  const taken = new Set(picked.map(keyOf))
  const spare = pool.filter((item) => !taken.has(keyOf(item)))
  while (out.length < SHOWCASE_SIZE && spare.length > 0) {
    const [next] = spare.splice(Math.floor(random() * spare.length), 1)
    out.push(next!)
  }
  return out
}

/**
 * One card on the LoRAs page: a LoRA with no parent, and every LoRA that names it as parent -
 * outfit variants, a body or face half. A second line of the same character is a second card:
 * from the LoRAs' point of view it is a new LoRA, in training or not (owner, 2026-09-21).
 */
export interface LoraGroup {
  /** Who the card is of. Two cards can share it; `line` tells them apart. */
  character: string
  /** The main LoRA's line, e.g. `ari_gen`. */
  line: string
  main: LoraEntry
  variants: LoraEntry[]
}

/**
 * Cards in catalogue order; a variant whose parent is not in the catalogue stands as its own card rather than vanishing.
 *
 * A parent resolves through the main's `olderVersions` too: an outfit added while the line was at v4 still
 * belongs to the card once v5 replaces v4, without anyone editing its entry (owner, 2026-09-24: every new
 * outfit must land under its character's card). The line is what an outfit belongs to, not one file of it.
 */
export function loraCards(entries: readonly LoraEntry[] = CUSTOM_LORAS): LoraGroup[] {
  const owner = new Map<string, LoraEntry>()
  for (const entry of entries) {
    if (entry.parent !== null) continue
    for (const name of [entry.name, ...entry.olderVersions]) owner.set(name, entry)
  }
  const mainOf = (entry: LoraEntry) => (entry.parent === null ? undefined : owner.get(entry.parent))
  const mains = entries.filter((entry) => mainOf(entry) === undefined)
  return mains.map((main) => ({
    character: main.character,
    line: loraLineBase(main.name),
    main,
    variants: entries.filter((entry) => mainOf(entry) === main),
  }))
}

export function loraGroupsByStatus(groups: readonly LoraGroup[] = loraCards()): Record<LoraStatus, LoraGroup[]> {
  return {
    final: groups.filter((group) => group.main.status === 'final'),
    wip: groups.filter((group) => group.main.status === 'wip'),
  }
}

/**
 * A LoRA's line: its name without the version suffix. `ari_gen_s1` and `ari_gen_v1` are both the
 * `ari_gen` line; an outfit added to it is `ari_gen_<outfit>`.
 */
export function loraLineBase(name: string): string {
  return name.replace(/_(v|s)\d+[a-z0-9]*$/, '')
}

/** `spacesuit`, `winter-coat`: lowercase, hyphens, nothing else. What folders, LoRA names and triggers are built from. */
export function outfitSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The names an outfit LoRA gets (owner's rule, 2026-09-21): the character's line as prefix, an
 * underscore, the outfit. Its trigger is the character's trigger with the outfit run on, so the
 * outfit word can never be mistaken for a tag.
 */
export function outfitLoraNames(main: LoraEntry, label: string) {
  const slug = outfitSlug(label)
  const base = `${loraLineBase(main.name)}_${slug.replace(/-/g, '_')}`
  return {
    slug,
    /** The line: what versions hang off. */
    base,
    stage1: `${base}_s1`,
    final: `${base}_v1`,
    trigger: `${main.trigger}${slug.replace(/-/g, '')}`,
    /** The character folder for `pnpm refs`. */
    refs: `${main.trigger}-${slug}`,
    dataset: `${main.trigger}-${slug}`,
  }
}

/**
 * The message the owner pastes into a Claude Code session, with the reference image attached, to
 * have a new outfit of an existing character built as its own LoRA: the reference set through
 * `/character-refs`, then the training recipe, then the catalogue. Everything a session without
 * memory needs is in the text; the image is the one thing only he can supply.
 */
export function outfitRequestPrompt(main: LoraEntry, label: string, imagePath?: string): string {
  const names = outfitLoraNames(main, label)
  const reference =
    imagePath && imagePath.trim().length > 0
      ? `the image at \`${imagePath.trim()}\``
      : 'the image attached to this message (if it did not reach disk, I will give you a path)'
  return [
    `/character-refs ${names.refs} - outfit variant`,
    '',
    `Add a new outfit to an existing character, as its own LoRA. Follow .ai/lora-training.md; nothing here changes the recipe.`,
    '',
    `Character: ${main.character} - line \`${loraLineBase(main.name)}\`, trigger \`${main.trigger}\`, current file \`${main.name}\`${main.dataset ? `, dataset \`${main.dataset}\`` : ''}.`,
    `Outfit: ${label} (slug \`${names.slug}\`).`,
    `New LoRA: \`${names.base}\` (stage 1 \`${names.stage1}\`, final \`${names.final}\`), trigger \`${names.trigger}\`, refs folder \`${names.refs}\`, dataset \`${names.dataset}\`.`,
    `Reference: ${reference}. It shows ${main.character} in the new outfit. Everything about her that is not the outfit stays exactly as in the existing character file.`,
    '',
    'Do, in this order, and stop for my go where the command says so:',
    `1. \`pnpm refs init ${names.refs} --reference <image>\`. Start from \`openai-character-dataset/characters/${main.trigger}/character.json\`: keep the description's face, hair, body and accessories word for word, replace only the outfit with what the image shows (every garment: cut, colour, material; footwear; what she does NOT wear now), and rewrite the audit list for this outfit - physics first, what of it shows from front, side, back, above, below.`,
    '2. `pnpm refs generate --dry-run`, tell me the count and the cost class, wait for my go. Then generate with --vault, read every frame against the audit list, send the frames to me individually with the view keys; I star in the vault.',
    `3. \`pnpm refs collect\`. Prep like \`prep-ari-gen.py\`: the new body refs with upper and cowboy crops, plus the character's existing head shots from \`sheets/${main.trigger}-face-refs-gen\` (the face is shared; the outfit is what varies). Captions trigger-only: \`${names.trigger}, 1girl, solo, <framing/pose/view>\` - no garment word, no colour, no background word.`,
    '4. Stage 1 (rank 32, 20 epochs, dressed only) -> the undressed candidate round on delburry75 and plantmilk at 1.2 with the bottom named and the censor words negated -> my stars -> final train (rank 64/32, ~30 epochs, undressed ~15 %) -> epoch sweep on the fixed check. Forge off for every run; daytime only while I am home.',
    `5. Catalogue: add the entry to packages/core/src/loras.ts (character '${main.character}', kind 'outfit', outfit '${label}', parent '${main.name}', trigger '${names.trigger}', dataset '${names.dataset}'), a row in docs/loras.md at dataset time, the file under models/Lora/wip/ until I say final.`,
  ].join('\n')
}
